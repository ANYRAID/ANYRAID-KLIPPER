// Firmware container formats from scripts/update_mks_robin.py and update_chitu.py.
// GPL-3.0-or-later; MKS original Copyright (C) 2020 Kevin O'Connor.
// Chitu algorithm derived from Marlin. MD5 is the format's key derivation, not authentication.
import {createHash} from 'node:crypto';
const pattern=Uint8Array.from([0xA3,0xBD,0xAD,0x0D,0x41,0x11,0xBB,0x8D,0xDC,0x80,0x2D,0xD0,0xD2,0xC4,0x9B,0x1E,0x26,0xEB,0xE3,0x33,0x4A,0x15,0xE4,0x0A,0xB3,0xB1,0x3C,0x93,0xBB,0xAF,0xF7,0x3E]);
export const maximumFirmwareBytes=64*1024*1024;
function check(input:Uint8Array):void {if(input.byteLength>maximumFirmwareBytes||input.buffer instanceof SharedArrayBuffer)throw new RangeError('Invalid firmware input size or shared buffer');}
export function encodeRobin(input:Uint8Array):Buffer {
 check(input);const output=Buffer.from(input);for(let pos=320;pos<Math.min(31040,output.length);pos++)output[pos]^=pattern[pos&31];return output;
}
export function encodeChitu(input:Uint8Array):{firmware:Buffer;uuid:string;blocks:number} {
 check(input);const digest=createHash('md5').update(input).digest(),hex=digest.toString('hex');
 const uuid=[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
 // Original appends the three ASCII bytes b'0x0' until divisible by 2048.
 const repeats=((2048-input.length%2048)%2048)*683%2048;
 const length=input.length+3*repeats,blocks=length/2048,output=Buffer.allocUnsafe(length+12),key=digest.readUInt32BE(0);
 output.writeUInt32BE(0x443d2d3f,0);output.writeUInt32LE(key,4);output.set(input,12);
 for(let i=input.length;i<length;i++)output[12+i]=[0x30,0x78,0x30][(i-input.length)%3];
 let crc=0xef3d4323;
 for(let block=0;block<blocks;block++) {
  const offset=12+block*2048,base=0x4bad*block;
  for(let i=0;i<2048;i++)output[offset+i]^=(Math.floor((i*i+base)/2**(i%24))^key)&255;
  for(let i=0;i<2048;i+=4)crc^=output.readUInt32LE(offset+i);
 }
 output.writeUInt32LE(crc>>>0,8);return {firmware:output,uuid,blocks};
}
