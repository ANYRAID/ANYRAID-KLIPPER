import {RebuiltMotionStreamer} from '../src/runtime/motion-streamer.ts';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {idleMotionFixture,idleTestMove} from '../test/helpers/idle-motion.ts';
const elapsed:number[][]=[[],[]];let reference:unknown;
for(let round=0;round<14;round++)for(const sourceBarrier of round%2?[1,0]:[0,1]){
 const f=idleMotionFixture(true);try{
  // Window transaction only: native source and bindings with a memory sink.
  const streamer=new RebuiltMotionStreamer({source:f.source,coordinator:f.coordinator,drain:f.driver,motion:{bindings:[{id:'x',stepper:f.x},{id:'e',stepper:f.e}]},assertClockCalibration(){}} as unknown as ConstructorParameters<typeof RebuiltMotionStreamer>[0]);
  const start=performance.now();f.source.startAt(1);let x=50;
  for(let i=0;i<200;i++){const next=x+(i%2?-1:1);f.source.append(idleTestMove(x,next,2));x=next;}
  const changes=[{stepper:'e',advance:.1,smoothTime:.2}];
  if(sourceBarrier){await streamer.reconfigurePressureWindows(changes,new AbortController().signal);await f.source.drain(idleTestMove(x,x+1,2.1),new AbortController().signal);}
  else{const b=await f.coordinator.drain(f.source.status.sourceTime,new Map([[f.xyz,[x,0,0] as const],[f.equeue,[2,0,0] as const]]),.25,undefined,.1);f.coordinator.reconfigurePressureWindows(b.generatedUntil,changes);const moves=idleTestMove(x,x+1,2.1),end=f.xyz.appendPlanned(moves,b.sourceUntil);assert.equal(f.equeue.appendPlanned(moves,b.sourceUntil,3),end);await f.coordinator.drain(end,new Map([[f.xyz,[x+1,0,0] as const],[f.equeue,[2.1,0,0] as const]]),.25);}
  const ms=performance.now()-start;if(round>=3)elapsed[sourceBarrier].push(ms);
  const result={ticks:f.ticks,positions:f.positions,filters:f.e.recoveryFilters()};if(reference===undefined)reference=structuredClone(result);else assert.deepEqual(result,reference);
  assert.deepEqual(f.positions,{x:200n,e:30n});assert.equal(f.stops,0);
 }finally{f.close();}
}
for(const times of elapsed)times.sort((a,b)=>a-b);
assert(elapsed[1][5]!<=elapsed[0][5]!*1.25+2);assert(elapsed[1][10]!<=elapsed[0][10]!*1.5+2);
console.log(JSON.stringify({node:process.version,moves:201,samples:11,allPulsesExact:true,sourceMedianMs:elapsed[1][5],sourceP95Ms:elapsed[1][10],manualMedianMs:elapsed[0][5],manualP95Ms:elapsed[0][10],scope:'native XYZE generation, source ownership and streamer window refresh; memory sink, no physical timing'},null,2));
