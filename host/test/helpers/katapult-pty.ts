import {setTimeout as delay} from 'node:timers/promises';
import {ptyPair} from './pty.ts';
import {katapultSimulator} from '../../bench/katapult-reference.ts';
import {katapultFrame} from '../../src/diagnostics/katapult.ts';
export function katapultPTY(options:{prime?:boolean;fragment?:boolean;silent?:boolean;corrupt?:boolean}={}){
 const pair=ptyPair(),sim=katapultSimulator(256);let buffered:Buffer=Buffer.alloc(0),primed:Buffer|undefined,chain=Promise.resolve(),closed=false,fault:unknown;
 const commands:number[]=[];
 pair.peer.on('data',(bytes:Buffer)=>{
  buffered=Buffer.concat([buffered,bytes]);
  while(buffered.length>=4){const length=buffered[3]*4+8;if(buffered.length<length)break;const frame=Buffer.from(buffered.subarray(0,length));buffered=buffered.subarray(length);commands.push(frame[2]);
   chain=chain.then(async()=>{
    if(closed||options.silent)return;
    if(frame[2]===0x90){primed=katapultFrame(0xf2);return;}
    if(options.prime&&!primed&&frame[2]===0x11)throw new Error('Missing priming command');
    let response=Buffer.from(await sim.transport.exchange(frame,2000,new AbortController().signal));
    if(options.corrupt)response[response.length-4]^=1;
    if(primed){response=Buffer.concat([primed,response]);primed=undefined;}
    if(options.fragment){for(let i=0;i<response.length;i+=3){if(closed)return;pair.peer.write(response.subarray(i,i+3));await delay(1);}}
    else pair.peer.write(response);
   }).catch(error=>{fault=error;});
  }
 });
 return {path:pair.path,commands,sim,async close(){closed=true;await chain;await pair.close();if(fault)throw fault;}};
}
