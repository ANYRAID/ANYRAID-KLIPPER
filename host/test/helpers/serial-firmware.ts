import {deflateSync} from 'node:zlib';
import {MessageDictionary} from '../../src/protocol/dictionary.ts';
import {FrameDecoder,encodeFrame} from '../../src/protocol/codec.ts';
import {serialClock} from '../../src/protocol/serial-queue.ts';
import {serialPair} from './serial-pair.ts';
export async function serialFirmware(){
 const pair=await serialPair(),dictionary=new MessageDictionary();const compressed=deflateSync(Buffer.from(JSON.stringify({commands:{get_uptime:2,get_clock:3,'echo value=%u':6},responses:{'uptime high=%u clock=%u':4,'clock clock=%u':5,'echo_response value=%u':7},config:{CLOCK_FREQ:1e6,RECEIVE_WINDOW:256}})));dictionary.identify(compressed);
 const decoder=new FrameDecoder(),start=serialClock.now();let ignored:string|undefined,frames=0,sequence=1;
 pair.peer.on('data',chunk=>{for(const frame of decoder.push(typeof chunk==='string'?Buffer.from(chunk):chunk)){frames++;const seq=(frame[1]+1)&15;sequence=seq;
  for(const cmd of dictionary.parseFrame(frame)){
   if(cmd.name===ignored)continue;
   const ticks=Math.round(1e6+(serialClock.now()-start)*1e6);let payload:Uint8Array;
   if(cmd.name==='identify'){const offset=cmd.parameters.offset as number;payload=dictionary.encode('identify_response',{offset,data:compressed.subarray(offset,offset+40)});}
   else if(cmd.name==='get_uptime')payload=dictionary.encode('uptime',{high:0,clock:ticks});
   else if(cmd.name==='get_clock')payload=dictionary.encode('clock',{clock:ticks});
   else payload=dictionary.encode('echo_response',{value:cmd.parameters.value});
   pair.peer.write(encodeFrame(seq,payload));
  }
  pair.peer.write(encodeFrame(seq,new Uint8Array()));
 }});
 return {...pair,dictionary,get frames(){return frames;},emitEcho(value:number){pair.peer.write(encodeFrame(sequence,dictionary.encode('echo_response',{value})));},ignore(name:string){ignored=name;}};
}
