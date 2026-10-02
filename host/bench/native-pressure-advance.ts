import assert from 'node:assert/strict';
import {nativeLinearFixture} from '../test/helpers/native-linear-port.ts';
const t=await nativeLinearFixture(0,()=>true,true),signal=new AbortController().signal,times:number[]=[],count=1000;
try{
 t.kinematics.markHomed([0]);t.port.move([51,0,0,2.1],10);const packets=t.f.fw.motion.length;
 for(let sample=0;sample<14;sample++){
  const start=performance.now();for(let i=0;i<count;i++)await t.port.setPressureAdvance('e',{advance:i%2?.1:.08,smoothTime:.04},signal);
  if(sample>=3)times.push((performance.now()-start)*1000/count);
  assert.equal(t.port.status.pendingMoves,1);assert.equal(t.f.fw.motion.length,packets);assert.equal(t.generation.source.status.seeded,false);assert.equal(t.port.pressureAdvanceSettings('e').advance,.1);
 }
 times.sort((a,b)=>a-b);assert(times[5]!<50);assert(times[10]!<100);assert.equal(t.f.stops,0);
 console.log(JSON.stringify({node:process.version,iterationsPerSample:count,samples:11,medianUs:times[5],p95Us:times[10],noLookaheadFlush:true,noNativePackets:true,maximumMedianUs:50,maximumP95Us:100,scope:'native port ownership, immutable pressure settings and pending endpoint coalescing; simulated MCU setup excluded, no physical printing'},null,2));
}finally{await t.close();}
