import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {HomingMoveExecution,type HomingMoveOptions,type HomingReadback} from '../src/homing/move-execution.ts';
import {HomingTriggerGroup} from '../src/homing/trigger-group.ts';
import {HomingTriggerSet} from '../src/homing/trigger-set.ts';
import {HomingSetRecovery} from '../src/homing/recovery.ts';
import {DripMotion} from '../src/homing/drip-motion.ts';
import {homingSetRecoveryOffsets} from '../src/homing/position-offsets.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {nativeHomingFixture} from '../test/helpers/homing-move-execution.ts';
async function direct(o:HomingMoveOptions){
 const groups=o.groups.map(g=>new HomingTriggerGroup(g.members,g.primary,g.endstop,g.sampling,g.startClocks,g.expireTimeout)),set=new HomingTriggerSet(groups),signal=new AbortController().signal;
 let readback!:HomingReadback;const stepper=o.bindings[0].stepper,session=o.groups[0].members[0].session;
 const recovery=new HomingSetRecovery({...o,release:()=>set.release(),locate:stop=>{const triggerClocks=[[stop.groups[0].hitClock??stepper.clockAt(o.endTime)]];readback={stop,histories:o.histories,triggerClocks,...homingSetRecoveryOffsets(stop,o.histories,triggerClocks)};return o.locate(readback);}});
 try{await set.arm(signal);await new DripMotion(o.coordinator,set,{estimatedPrintTime:()=>stepper.printTimeAtClock(session.clock.sync.getClock(serialClock.now()))}).run(o.startTime,o.endTime,signal);const {motion}=await recovery.recover(signal);return {...readback,motion};}
 finally{set.release();}
}
const elapsed:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let round=0;round<14;round++)for(const managed of round%2?[1,0]:[0,1]){
 const x=await nativeHomingFixture();let result:Awaited<ReturnType<typeof direct>>|undefined,move:HomingMoveExecution|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 try{
  timer=setTimeout(()=>x.hit(0),225);const before=process.cpuUsage(),start=performance.now();
  if(managed){move=new HomingMoveExecution(x.options);result=await move.run(new AbortController().signal);}else result=await direct(x.options);
  const milliseconds=performance.now()-start,used=process.cpuUsage(before);
  assert.deepEqual(result.missingHits,[]);assert.deepEqual(result.offsets.map(o=>[o.trigger,o.halt,o.overshoot]),[[20n,23n,3n]]);assert(Math.abs(result.motion.bindings[0].stepper.commandedPosition-3.03)<1e-12);assert.equal(x.f.stops,0);
  if(round>=3){elapsed[managed].push(milliseconds);cpu[managed].push((used.user+used.system)/1000);}
 }finally{clearTimeout(timer);result?.motion.dispose();move?.dispose();await x.close();}
}
for(const samples of [...elapsed,...cpu])samples.sort((a,b)=>a-b);const stats=(s:number[])=>({medianMs:s[5],p95Ms:s[10]});
console.log(JSON.stringify({node:process.version,samples:11,direct:{elapsed:stats(elapsed[0]),cpu:stats(cpu[0])},managed:{elapsed:stats(elapsed[1]),cpu:stats(cpu[1])},scope:'native arm/drip/history/readback/rebuild/reset with scheduled emulated hit; excludes session bootstrap and physical hardware'}));
assert(elapsed[1][5]<=elapsed[0][5]*1.25,'Median end-to-end homing pass overhead exceeded 25%');assert(cpu[1][5]<=cpu[0][5]*1.75+1,'Median orchestration CPU regression exceeded 75% plus 1ms');assert(cpu[1][5]<20,'Median desktop CPU budget exceeded 20ms per homing pass');
