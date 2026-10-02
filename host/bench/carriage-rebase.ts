import assert from 'node:assert/strict';
import {CoordinateRebase} from '../src/homing/recovery.ts';
import {recoveryFixture} from '../test/helpers/homing-recovery.ts';
const results=[];
for(const replacement of [false,true]){
 const samples:number[]=[];
 for(let run=0;run<6;run++){
  const f=await recoveryFixture(2);let motion:Awaited<ReturnType<CoordinateRebase['recover']>>['motion']|undefined;
  try{
   f.fs.forEach(fw=>fw.setTriggerReason(2));const start=performance.now();
   motion=(await new CoordinateRebase({...f.options,...(replacement?{carriageTransforms:[{id:'s0',transform:{xScale:1,xOffset:0,yScale:1,yOffset:0}},{id:'s1',transform:{xScale:-1,xOffset:180,yScale:1,yOffset:0}}]}:{})}).recover(new AbortController().signal)).motion;
   const elapsed=performance.now()-start;assert.deepEqual(motion.bindings.map(b=>b.stepper.flush().position),[100n,101n]);assert(f.fs.every(fw=>fw.motion.length===0));if(run)samples.push(elapsed);
  }finally{motion?.dispose();await f.close();}
 }
 results.push({replacement,samplesMs:samples,medianMs:[...samples].sort((a,b)=>a-b)[2]});
}
console.log(JSON.stringify({runtime:process.version,scope:'Two simulated MCU socket stop/readback/reset transactions; excludes fixture startup; no physical motors or production latency claim',results},null,2));
