import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {idleMotionFixture} from '../test/helpers/idle-motion.ts';
import {Move,LookAheadQueue,motionLimits} from '../src/motion/lookahead.ts';
import {markPressureBoundary} from '../src/motion/pressure-boundaries.ts';
const limits=motionLimits(100,100,5,0),q=new LookAheadQueue();for(let i=0;i<10000;i++)q.add(new Move(limits,[50+i,0,0,2+i*.1],[51+i,0,0,2+(i+1)*.1],10));const moves=q.flush(),times:number[]=[],cpu:number[]=[];
for(let i=99;i<moves.length;i+=100)markPressureBoundary(moves[i],{stepper:'e',advance:i%200===99?.08:.1});
for(let i=0;i<14;i++){
 const f=idleMotionFixture(true);try{
  f.source.startAt(1);f.source.append(moves);const used=process.cpuUsage(),start=performance.now(),stop=await f.source.brakeAt(501,new AbortController().signal),ms=performance.now()-start,usage=process.cpuUsage(used);
  assert.throws(()=>f.e.recoveryFilters(),/settle/);
  assert(stop.remainder.some(m=>m.pressureBoundaries?.length));
  assert(Math.abs(stop.position[0]-5050)<1e-6);assert(Math.abs(stop.position[3]-502)<1e-6);assert.deepEqual(stop.remainder.at(-1)!.endPos,[10050,0,0,1002]);assert.equal(f.commits,0);assert.equal(f.stops,0);assert.equal(f.source.status.braking,true);
  if(i>=3){times.push(ms);cpu.push((usage.user+usage.system)/1000);}
 }finally{f.close();}
}
times.sort((a,b)=>a-b);cpu.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,moves:10000,pressureEndpoints:100,samples:11,elapsed:{medianMs:times[5],p95Ms:times[10]},cpu:{medianMs:cpu[5],p95Ms:cpu[10]},scope:'owned source lookup, path braking, future pressure cancellation and endpoint retiming, XYZ/E native replacement and restart suffix; source setup excluded; no generation or MCU completion'}));
assert(times[5]<25,'Source braking exceeds 25ms desktop median budget for 10000 buffered moves');
