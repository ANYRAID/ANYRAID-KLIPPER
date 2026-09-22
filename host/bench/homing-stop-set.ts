import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {HomingStopConfirmation} from '../src/homing/stop-confirmation.ts';
import {HomingStopSetConfirmation} from '../src/homing/stop-set.ts';
import {stopSetFixture} from '../test/helpers/homing-stop-set.ts';
for(const shared of [false,true]){
 const {f,groups}=await stopSetFixture(shared),samples:number[][]=[[],[]],iterations=20;
 try{
  for(let round=0;round<14;round++)for(const managed of round%2?[1,0]:[0,1]){
   const start=performance.now();
   for(let i=0;i<iterations;i++){
    const signal=new AbortController().signal;
    const result=managed?(await new HomingStopSetConfirmation(groups,()=>{}).finish(signal)).groups:await Promise.all(groups.map(g=>new HomingStopConfirmation(g.members,g.primary,g.endstop,g.sampling,()=>{}).finish(signal)));
    assert.deepEqual(result.map(r=>r.hitClock),groups.map(g=>g.sampling.reqClock));assert.deepEqual(result.map(r=>r.positions[0].position),[100n,101n]);assert(result.every(r=>r.reasons[0]===1));
   }
   if(round>=3)samples[managed].push(performance.now()-start);
  }
  for(const sample of samples)sample.sort((a,b)=>a-b);
  const stats=(s:number[])=>({medianMs:s[5],p95Ms:s[10]});
  console.log(JSON.stringify({node:process.version,sharedMCU:shared,iterations,raw:stats(samples[0]),managed:stats(samples[1]),scope:'native protocol emulator, stop/readback and aggregation; excludes arming, physical switches and movement'}));
  assert(samples[1][5]<=samples[0][5]*1.75,'Median stop/readback regression exceeded 75% including additional sampling ACK barrier');assert(samples[1][5]/iterations<2,'Median stop/readback exceeded desktop 2ms budget');assert.equal(f.stops,0);
 }finally{await f.close();}
}
