import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {tmc220xStatusReader} from '../src/drivers/tmc220x-status.ts';
import {StepperPosition} from '../src/motion/stepper-position.ts';
import {NativeObjects} from '../src/moonraker/native-objects.ts';
const state={closed:false,checks:1,drvStatus:0x801f0000,gstat:0,warnings:0,fault:undefined},plan={model:'tmc2209',current:{runCurrent:.8,holdCurrent:.3}},names=['x','y','z','e'];
const catalogs=[false,true].map(withPhase=>new NativeObjects(new Map(names.map((n,i)=>{
 const position=new StepperPosition(40,3200);position.align(100n,i);
 return [n,tmc220xStatusReader(plan,{status:state},()=>plan.current,()=>withPhase?{offset:7,position:position.commandedPosition(7n)}:null)];
})),()=>1));
const query=Object.fromEntries(names.map(n=>[n,null])),timings:number[][]=[[],[]];
for(let batch=0;batch<11;batch++)for(const mode of batch%2?[1,0]:[0,1]){
 const start=performance.now();for(let i=0;i<2000;i++){const result=catalogs[mode].query(query);assert.equal(Object.keys(result.status).length,4);}if(batch>=2)timings[mode].push(performance.now()-start);
}
console.log(JSON.stringify({node:process.version,queries:2000,drivers:4,scope:'Alternating paired cached status projection with/without current StepperPosition phase conversion; no HTTP or serial I/O',milliseconds:timings.map(values=>{values.sort((a,b)=>a-b);return {median:values[4],max:values.at(-1),samples:values};})},null,2));
