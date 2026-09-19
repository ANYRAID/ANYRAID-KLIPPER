// MCU wire codec derived from klippy/msgproto.py and chelper/msgblock.c.
// Copyright (C) 2016-2024 Kevin O'Connor. GPL-3.0-or-later.
export const MIN_FRAME=5, MAX_FRAME=64, MAX_PAYLOAD=59, SYNC=0x7e;
export class ProtocolError extends Error {}
export function crc16(data:Uint8Array,end=data.length):number {
  let crc=0xffff;
  for(let i=0;i<end;i++) {
    let value=data[i]^(crc&0xff);
    value^=(value&0xf)<<4;
    crc=((value<<8)|(crc>>>8))^(value>>>4)^(value<<3);
  }
  return crc;
}
/** Parameters have one shared wire range, including %c and %hu. */
export function encodeInteger(value:number,out:number[]=[]):number[] {
  if(!Number.isInteger(value) || value < -0x80000000 || value > 0xffffffff)
    throw new ProtocolError('Integer outside MCU wire range');
  // Arithmetic division is required: JS signed shifts corrupt positive uint32.
  if(value>=0xc000000 || value< -0x4000000) out.push((Math.floor(value/2**28)&0x7f)|0x80);
  if(value>=0x180000 || value< -0x80000) out.push((Math.floor(value/2**21)&0x7f)|0x80);
  if(value>=0x3000 || value< -0x1000) out.push((Math.floor(value/2**14)&0x7f)|0x80);
  if(value>=0x60 || value< -0x20) out.push((Math.floor(value/2**7)&0x7f)|0x80);
  out.push(value&0x7f);
  return out;
}
export interface IntegerResult {value:number; next:number;}
export function decodeInteger(data:Uint8Array,offset=0,signed=false,end=data.length):IntegerResult {
  if(!Number.isInteger(offset) || offset<0 || !Number.isInteger(end) || end>data.length || offset>=end)
    throw new ProtocolError('Truncated integer');
  let c=data[offset++],value=c&0x7f,count=1;
  if((c&0x60)===0x60) value|= -0x20;
  while(c&0x80) {
    if(offset>=end) throw new ProtocolError('Truncated integer');
    if(count++>=5) throw new ProtocolError('Overlong integer');
    c=data[offset++]; value=value*128+(c&0x7f);
  }
  if(value< -0x80000000 || value>0xffffffff) throw new ProtocolError('Integer overflow');
  return {value:signed ? value : value>>>0,next:offset};
}
export function encodeFrame(sequence:number,payload:Uint8Array):Uint8Array {
  if(!Number.isSafeInteger(sequence)) throw new ProtocolError('Invalid sequence');
  if(payload.length>MAX_PAYLOAD) throw new ProtocolError('Frame payload exceeds 59 bytes');
  const frame=new Uint8Array(payload.length+MIN_FRAME);
  frame[0]=frame.length; frame[1]=(sequence&15)|0x10; frame.set(payload,2);
  const crc=crc16(frame,frame.length-3);
  frame[frame.length-3]=crc>>>8; frame[frame.length-2]=crc&255; frame[frame.length-1]=SYNC;
  return frame;
}
/** 0 = incomplete, -1 = corrupt, positive = first complete frame length. */
export function checkFrame(data:Uint8Array):number {
  if(data.length<MIN_FRAME) return 0;
  const length=data[0];
  if(length<MIN_FRAME || length>MAX_FRAME || (data[1]&0xf0)!==0x10) return -1;
  if(data.length<length) return 0;
  if(data[length-1]!==SYNC || crc16(data,length-3)!==((data[length-3]<<8)|data[length-2])) return -1;
  return length;
}
/** Streaming resynchronization follows chelper/msgblock.c, with 64 bytes of storage. */
export class FrameDecoder {
  #buffer=new Uint8Array(MAX_FRAME);
  #length=0;
  #needSync=false;
  discardedBytes=0;
  get bufferedBytes():number {return this.#length;}
  reset():void {this.#length=0;this.#needSync=false;}
  push(chunk:Uint8Array):Uint8Array[] {
    const frames:Uint8Array[]=[];
    for(const byte of chunk) {
      if(this.#needSync) {
        this.discardedBytes++;
        if(byte===SYNC) this.#needSync=false;
        continue;
      }
      this.#buffer[this.#length++]=byte;
      while(this.#length>=MIN_FRAME) {
        const view=this.#buffer.subarray(0,this.#length),status=checkFrame(view);
        if(status===0) break;
        if(status>0) {
          frames.push(view.slice(0,status));
          this.#buffer.copyWithin(0,status,this.#length); this.#length-=status;
        } else {
          const sync=view.indexOf(SYNC);
          if(sync===-1) {
            this.discardedBytes+=this.#length; this.#length=0; this.#needSync=true;
          } else {
            this.discardedBytes+=sync+1;
            this.#buffer.copyWithin(0,sync+1,this.#length); this.#length-=sync+1;
          }
        }
      }
    }
    return frames;
  }
}
/** Nearest 64-bit extension, preserving C uint64 wrap and +/-2^31 ambiguity. */
export function extendClock(last:bigint,clock32:number):bigint {
  if(last<0n || last>0xffffffffffffffffn || !Number.isInteger(clock32) || clock32<0 || clock32>0xffffffff)
    throw new ProtocolError('Invalid MCU clock');
  return BigInt.asUintN(64,last+BigInt.asIntN(32,BigInt(clock32)-last));
}
