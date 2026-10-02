import assert from 'node:assert/strict';
import {FilamentEncoder} from '../src/inputs/filament-encoder.ts';
const times:number[]=[];
for(let run=0;run<13;run++){
 let now=0,position=0,edge:(t:number,p:boolean)=>void=()=>{},raw=false,pauses=0;const generation={},timers=new Map<()=>void,number>();
 const owner=new FilamentEncoder({status:{received:false,present:false,time:undefined},subscribe(fn){edge=fn;return ()=>{};}},{pause:true,debounce:0,eventDelay:3,detectionLength:7},{now:()=>now,schedule(fn,seconds){timers.set(fn,now+seconds);return ()=>{timers.delete(fn);};}},()=>({position,generation}),()=>true,async()=>{pauses++;},error=>{throw error;});
 const begin=performance.now();for(let i=0;i<20000;i++){now+=.25;position+=.01;if(i%10===0){raw=!raw;edge(now,raw);}for(const [fn,at] of [...timers])if(at<=now){timers.delete(fn);fn();}assert(timers.size<=2);}const elapsed=performance.now()-begin;assert.equal(owner.status.filament_detected,true);assert.equal(owner.canResume,true);assert.equal(pauses,0);owner.close();assert.equal(timers.size,0);if(run>=2)times.push(elapsed);
}
times.sort((a,b)=>a-b);assert(times[10]<1000);console.log(JSON.stringify({node:process.version,polls:20000,edges:2000,samples:11,medianMs:times[5],p95Ms:times[10],scope:'Encoder runtime with bounded synthetic timers and constant-time position provider; no physical IO'},null,2));
