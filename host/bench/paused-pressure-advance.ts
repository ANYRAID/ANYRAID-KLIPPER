import assert from 'node:assert/strict';
import {nativeLinearFixture} from '../test/helpers/native-linear-port.ts';
const t=await nativeLinearFixture(0,()=>true,true),signal=new AbortController().signal,times:number[]=[],count=1000;
try{
 await t.port.pause(signal);const before=t.generation.source.status.sourceTime,first=performance.now();await t.port.setPressureAdvance('e',{advance:.1,smoothTime:.2},signal);const firstReservationMs=performance.now()-first,firstSourceAdvanceSeconds=t.generation.source.status.sourceTime-before;
 const time=t.generation.source.status.sourceTime,generated=t.generation.coordinator.status.generatedTime,packets=t.f.fw.motion.length,position=t.generation.motion.bindings[1].stepper.commandedPosition;
 for(let sample=0;sample<14;sample++){
  const start=performance.now();for(let i=0;i<count;i++)await t.port.setPressureAdvance('e',{advance:i%3?.2:0,smoothTime:i%2?.02:.2},signal);
  if(sample>=3)times.push((performance.now()-start)*1000/count);
  assert.equal(t.generation.source.status.sourceTime,time);assert.equal(t.generation.coordinator.status.generatedTime,generated);assert.equal(t.generation.motion.bindings[1].stepper.commandedPosition,position);assert.equal(t.f.fw.motion.length,packets);assert.equal(t.generation.source.status.paused,true);
 }
 times.sort((a,b)=>a-b);assert(times[5]!<100);assert(times[10]!<200);assert.equal(t.f.stops,0);
 console.log(JSON.stringify({node:process.version,samples:11,iterationsPerSample:count,firstReservationMs,firstSourceAdvanceSeconds,medianUs:times[5],p95Us:times[10],maximumMedianUs:100,maximumP95Us:200,reusedStationaryBoundary:true,noGeneratedMotion:true,noNativePackets:true,scope:'paused port ownership, native stationary validation and window replacement; initial drain and first reservation excluded; simulated MCU, no hardware acceptance'},null,2));
}finally{await t.close();}
