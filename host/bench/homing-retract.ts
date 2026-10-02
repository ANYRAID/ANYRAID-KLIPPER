import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {HomingRetractExecution} from '../src/homing/retract-execution.ts';
import {LinearKinematics} from '../src/kinematics/linear.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {rebuiltFixture} from '../test/helpers/rebuilt-motion.ts';
import {LookAheadQueue,Move,motionLimits} from '../src/motion/lookahead.ts';
const elapsed:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let round=0;round<14;round++)for(const managed of round%2?[1,0]:[0,1]){
 const f=await rebuiltFixture();try{
  const g=await bindRebuiltMotion(f.options),k=new LinearKinematics({kind:'cartesian',ranges:[[0,200],[0,200],[0,200]],maxVelocity:100,maxAccel:1000,maxZVelocity:5,maxZAccel:100}),signal=new AbortController().signal;
  const used=process.cpuUsage(),start=performance.now();
  if(managed)await new HomingRetractExecution(g,k).run([51,0,0,2],10,0,signal);
  else{const queue=new LookAheadQueue();queue.add(new Move(motionLimits(100,1000),f.options.position,[51,0,0,2],10));await g.source.drain(queue.flush(),signal);}
  const ms=performance.now()-start,usage=process.cpuUsage(used);
  assert.equal(g.motion.bindings[0].history.status.lastPlannedPosition,200n);assert.equal(g.motion.bindings[1].history.status.lastPlannedPosition,20n);assert.equal(k.status.homedAxes,'');assert.equal(f.stops,0);
  if(round>=3){elapsed[managed].push(ms);cpu[managed].push((usage.user+usage.system)/1000);}
 }finally{await f.close();}
}
for(const s of [...elapsed,...cpu])s.sort((a,b)=>a-b);const stats=(s:number[])=>({medianMs:s[5],p95Ms:s[10]});
console.log(JSON.stringify({node:process.version,samples:11,manual:{elapsed:stats(elapsed[0]),cpu:stats(cpu[0])},managed:{elapsed:stats(elapsed[1]),cpu:stats(cpu[1])},scope:'native single-axis retract planning, archive, serial ACK and sampled MCU-time drain; setup excluded; no physical printer'}));
assert(elapsed[1][5]<=elapsed[0][5]*1.25,'Retreat median elapsed overhead exceeds 25%');assert(cpu[1][5]<=cpu[0][5]*1.5+1,'Retreat CPU overhead exceeds 50% plus 1ms');assert(cpu[1][5]<20,'Retreat CPU median exceeds 20ms desktop budget');
