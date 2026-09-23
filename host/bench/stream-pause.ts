import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {rebuiltFixture} from '../test/helpers/rebuilt-motion.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {RebuiltMotionStreamer} from '../src/runtime/motion-streamer.ts';
import {LookAheadQueue,Move,motionLimits} from '../src/motion/lookahead.ts';
import {inputShaper} from '../src/motion/shaper.ts';
const times:number[]=[],cpu:number[]=[];
for(let i=0;i<14;i++){
 const f=await rebuiltFixture(),cancel=new AbortController(),cause=new Error('pause benchmark complete');let completed:Promise<void>|undefined;
 try{
  const g=await bindRebuiltMotion(f.options);g.motion.bindings[0].stepper.configureShapers({x:inputShaper('mzv',40,.1)});g.motion.bindings[1].stepper.configurePressureAdvance(.05,.04);
  const stream=new RebuiltMotionStreamer(g),q=new LookAheadQueue();q.add(new Move(motionLimits(100,100,5,0),[50,0,0,2],[150,0,0,12],10));
  completed=assert.rejects(stream.append(q.flush(),cancel.signal),error=>error===cause);
  const deadline=performance.now()+3000;while(!f.fw.motion.some(m=>m.name==='queue_step')){assert(performance.now()<deadline);await delay(2);}
  const used=process.cpuUsage(),start=performance.now(),paused=await stream.requestPause(),ms=performance.now()-start,usage=process.cpuUsage(used);
  assert(paused.position[0]>50&&paused.position[0]<150);assert.equal(g.source.status.paused,true);assert.equal(f.stops,0);
  assert.equal(g.motion.bindings[0].history.status.lastPlannedPosition,100n+BigInt(Math.round((paused.position[0]-50)/.01)));
  assert.equal(g.motion.bindings[1].history.status.lastPlannedPosition,20n+BigInt(Math.round((paused.position[3]-2)/.01)));
  if(i>=3){times.push(ms);cpu.push((usage.user+usage.system)/1000);}
 }finally{cancel.abort(cause);try{await completed;}finally{await f.close();}}
}
times.sort((a,b)=>a-b);cpu.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,samples:11,elapsed:{medianMs:times[5],p95Ms:times[10]},cpu:{medianMs:cpu[5],p95Ms:cpu[10]},scope:'pause request after first native step batch through MZV/pressure-advance braking, serial delivery and sampled MCU drain; 10-second input move; no physical hardware or product parking'}));
assert(times[5]<1200,'Controlled pause exceeds 1200ms desktop median budget');assert(cpu[5]<30,'Controlled pause exceeds 30ms desktop CPU budget');
