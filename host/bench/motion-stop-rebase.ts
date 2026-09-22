import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {CoordinateRebase} from '../src/homing/recovery.ts';
import type {HomingMember,HomingStopResult} from '../src/homing/stop-confirmation.ts';
import {rebuildStoppedMotion} from '../src/homing/rebuild-motion.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {recoveryFixture} from '../test/helpers/homing-recovery.ts';
async function stopDirect(members:readonly HomingMember[],signal:AbortSignal):Promise<HomingStopResult>{
 const positions=(await Promise.all(members.map(async(m,member)=>{
  const d=m.session.dictionary;
  await m.session.queryOnQueue(m.queue,m.trigger.trigger(2),'trsync_state',signal,{oid:m.trigger.oid});
  const expire=m.session.clock.sync.getClock(serialClock.now()+1);
  const payloads=[d.encode('trsync_start',{oid:m.trigger.oid,report_clock:0,report_ticks:0,expire_reason:4}),d.encode('trsync_set_timeout',{oid:m.trigger.oid,clock:Number(BigInt.asUintN(32,expire))}),...m.steppers.map(s=>d.encode('stepper_stop_on_trigger',{oid:s.oid,trsync_oid:m.trigger.oid}))];
  for(const p of payloads)await m.queue.send(p,0n,0n,signal);
  const state=await m.session.queryOnQueue(m.queue,m.trigger.trigger(2),'trsync_state',signal,{oid:m.trigger.oid});assert.equal(m.trigger.decode(state.message)!.reason,2);
  const result:HomingStopResult['positions'][number][]=[];
  for(const stepper of m.steppers){const reply=await m.session.queryOnQueue(m.queue,d.encode('stepper_get_position',{oid:stepper.oid}),'stepper_position',signal,{oid:stepper.oid}),raw=reply.message.parameters.pos as number;result.push({member,oid:stepper.oid,raw,position:BigInt(stepper.inverted?-raw:raw),observedClock:m.session.clock.sync.getClock(reply.receiveTime)});}return result;
 }))).flat();return {hitClock:null,reasons:members.map(()=>2),positions};
}
const samples:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let round=0;round<14;round++)for(const managed of round%2?[1,0]:[0,1]){
 const f=await recoveryFixture(1);let motion:ReturnType<typeof rebuildStoppedMotion>|undefined;
 try{
  f.fs[0].setTriggerReason(2);const signal=new AbortController().signal,before=process.cpuUsage(),start=performance.now();
  if(managed)motion=(await new CoordinateRebase(f.options).recover(signal)).motion;
  else{
   const [,stop]=await Promise.all([f.options.coordinator.retire(signal),stopDirect(f.options.members,signal)]),located=f.options.locate(stop);
   motion=rebuildStoppedMotion(stop,f.options.bindings,located.queues,f.options.emitters,located.printTime);
   await Promise.all(f.options.members.map(async m=>{for(const stepper of m.steppers)await m.queue.send(m.session.dictionary.encode('reset_step_clock',{oid:stepper.oid,clock:0}),0n,0n,signal);}));
  }
  const elapsed=performance.now()-start,used=process.cpuUsage(before);assert.equal(motion.bindings[0].history.status.lastPlannedPosition,100n);assert.equal(motion.bindings[0].stepper.commandedPosition,10);assert.equal(f.stops,0);
  if(round>=3){samples[managed].push(elapsed);cpu[managed].push((used.user+used.system)/1000);}
 }finally{motion?.dispose();await f.close();}
}
for(const s of [...samples,...cpu])s.sort((a,b)=>a-b);const stats=(s:number[])=>({medianMs:s[5],p95Ms:s[10]});
console.log(JSON.stringify({node:process.version,samples:11,raw:{elapsed:stats(samples[0]),cpu:stats(cpu[0])},managed:{elapsed:stats(samples[1]),cpu:stats(cpu[1])},scope:'native explicit stop, readback, generation retirement, forced-coordinate rebuild and reset; no session bootstrap or physical printer'}));
assert(samples[1][5]<=samples[0][5]*1.75,'Median coordinate rebase overhead exceeds 75%');assert(cpu[1][5]<=cpu[0][5]*1.75+1,'Median CPU overhead exceeds 75% plus 1ms');assert(samples[1][5]<10,'Coordinate rebase exceeds 10ms desktop median budget');
