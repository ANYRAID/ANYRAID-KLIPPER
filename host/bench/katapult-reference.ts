import {frozenKatapultReference} from './katapult-contract.ts';
import {katapultFrame,type KatapultTransport} from '../src/diagnostics/katapult.ts';
export function katapultSimulator(blockSize=64,start=0x8004000){
 const frames:Buffer[]=[],memory=new Map<number,Buffer>();
 const transport:KatapultTransport={async exchange(frame){
  frames.push(Buffer.from(frame));const cmd=frame[2],p=frame.subarray(4,-4);let response=Buffer.alloc(0);
  if(cmd===0x11){response=Buffer.alloc(28);response.set([0,1,1,0]);response.writeUInt32LE(start,4);response.writeUInt32LE(blockSize,8);response.write('stm32f407\0test',12);}
  else if(cmd===0x12){memory.set(p.readUInt32LE(),Buffer.from(p.subarray(4)));response=Buffer.from(p.subarray(0,4));}
  else if(cmd===0x13){response=Buffer.alloc(4);response.writeUInt32LE(memory.size);}
  else if(cmd===0x14)response=Buffer.concat([p,memory.get(p.readUInt32LE())!]);
  else if(cmd===0x16)response=Buffer.from('1122334455660000','hex');
  else if(cmd!==0x15)throw new Error('Unexpected mock command');
  const echoed=Buffer.alloc(4);echoed.writeUInt32LE(cmd);return katapultFrame(0xa0,Buffer.concat([echoed,response]));
 }};
 return {transport,frames,memory};
}
export function katapultReference(image:Uint8Array,blockSize:number,runs=1):{frames:string[];sha1:string;samples:number[];python:string}{
 return frozenKatapultReference('protocol',{image:Buffer.from(image).toString('hex'),blockSize,runs});
}
