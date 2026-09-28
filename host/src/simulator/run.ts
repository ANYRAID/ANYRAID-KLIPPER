import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {AVREngine} from './engine.ts';
import {simulatorTerminal} from './terminal.ts';
export interface AVRRunOptions {binary:string;elf:string;port:string;machine:string;speed:number;baud:number;rate:number;trace?:{file:string;signals:string};}
export async function runAVR(options:AVRRunOptions,signal:AbortSignal,ready:(path:string)=>void=()=>{}):Promise<{time:bigint;steps:number}>{
 if(!Number.isFinite(options.rate)||options.rate<0||options.rate>1e6)throw new RangeError('Invalid simulation pacing rate');
 signal.throwIfAborted();const engine=new AVREngine(options.binary,options.elf,options);let terminal:ReturnType<typeof simulatorTerminal>|undefined;
 let time=0n,steps=0;
 try{
  const initial=await engine.advance(1);time=initial.time;
  terminal=simulatorTerminal(options.port);await terminal.write(initial.bytes,signal);ready(terminal.path);
  const origin=performance.now(),epoch=time;
  while(!signal.aborted){
   const result=await engine.advance(1000000,terminal.read());time=result.time;steps++;
   await terminal.write(result.bytes,signal);
   if(options.rate){const elapsed=time-epoch,simulatedMs=Number(elapsed/1000000n)+Number(elapsed%1000000n)/1e6;
    let wait=simulatedMs/options.rate-(performance.now()-origin);while(wait>=1){await delay(Math.min(wait,1000),undefined,{signal});wait=simulatedMs/options.rate-(performance.now()-origin);}}
  }
 }catch(error){if(!signal.aborted)throw error;}
 finally{try{await engine.close();}finally{terminal?.close();}}
 return {time,steps};
}
