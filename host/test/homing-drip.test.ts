import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DripMotion} from '../src/homing/drip-motion.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator,type MotionBatch} from '../src/motion/coordinator.ts';
import type {HomingTriggerSet,TriggerGroupOutcome} from '../src/homing/trigger-set.ts';
function triggers(){
 let resolve!:(v:readonly TriggerGroupOutcome[])=>void,reject!:(e:unknown)=>void,stops=0;
 const status={armed:true,released:false,remaining:1,failed:false,fault:undefined as unknown,cleanupPending:false,cleanupErrors:[] as unknown[]};
 const completion=new Promise<readonly TriggerGroupOutcome[]>((a,b)=>{resolve=a;reject=b;});
 const value:Pick<HomingTriggerSet,'completion'|'status'|'stop'>={completion,status,async stop(error){stops++;status.failed=true;status.fault=error;reject(error);}};
 return {value,resolve:()=>{status.remaining=0;resolve([{group:0,member:0,reason:1}]);},reject:(e:unknown)=>{status.failed=true;status.fault=e;reject(e);},get stops(){return stops;}};
}
async function fixture(commit:(batch:Readonly<MotionBatch>)=>Promise<void>=async()=>{}){
 const q=new TrapQueue();q.appendRaw(new Float64Array([1,0,1,0,0,0,0,1,0,0,10,10,0]));
 const stepper=q.createStepper({frequency:1e6,timeOffset:0,oid:1,maxError:0,queueStepTag:5,directionTag:6},'x',.01);
 let stops=0;const batches:Readonly<MotionBatch>[]=[];
 const c=new MotionCoordinator([{id:'x',queue:q,stepper}],{async commit(b){batches.push(b);await commit(b);},async stop(){stops++;}});
 await c.advance(1);batches.length=0;
 return {q,stepper,c,batches,get stops(){return stops;},[Symbol.dispose](){stepper.dispose();q.dispose();}};
}
const signal=()=>new AbortController().signal;
test('drip limits native generation to 50ms segments and stops at completion, preserving compressed history',async()=>{
 const t=triggers();let count=0;
 using f=await fixture(async b=>{if(b.generatedUntil!>1&&++count===2)t.resolve();});
 const drip=new DripMotion(f.c,t.value,{estimatedPrintTime:()=>1});
 const result=await drip.run(1,2,signal());
 assert.equal(result.reason,'triggered');assert(Math.abs(result.generatedUntil-1.1)<1e-12);
 assert.equal(f.batches.length,2);for(const b of f.batches){assert(b.generatedUntil!-b.from<=.052000001);assert(b.outputs[0].history.length>0);}
 assert.equal(f.stops,0);assert.equal(t.stops,0);assert.equal(f.c.status.failed,false);
 await assert.rejects(drip.run(1,2,signal()),/single use/);
});
test('completion already available prevents any first segment',async()=>{
 using f=await fixture();const t=triggers();t.resolve();
 assert.equal((await new DripMotion(f.c,t.value,{estimatedPrintTime:()=>1}).run(1,2,signal())).reason,'triggered');assert.equal(f.batches.length,0);
});
test('completion interrupts buffer wait without generating future segments',async()=>{
 using f=await fixture();const t=triggers();const timer=setTimeout(()=>t.resolve(),10);
 try{assert.equal((await new DripMotion(f.c,t.value,{estimatedPrintTime:()=>0}).run(1,2,signal())).reason,'triggered');assert.equal(f.batches.length,0);}finally{clearTimeout(timer);}
});
test('endpoint flush waits for MCU time before reporting exhaustion',async()=>{
 using f=await fixture();const t=triggers();let now=1,done=false;
 const run=new DripMotion(f.c,t.value,{estimatedPrintTime:()=>now}).run(1,1.05,signal()).then(r=>{done=true;return r;});
 await new Promise(r=>setTimeout(r,15));assert.equal(done,false);assert.equal(f.batches.length,1);assert.equal(f.c.status.committedTime,1.05);
 now=1.05;assert.equal((await run).reason,'exhausted');assert(Math.abs(f.stepper.commandedPosition-.5)<1e-12);assert.equal(f.batches.at(-1)!.outputs[0].position,50n);assert.equal(f.stops,0);
});
test('cancel or failure during buffer wait stops motion and all trigger groups',async()=>{
 for(const mode of ['cancel','fault','timeout']){
  using f=await fixture();const t=triggers(),abort=new AbortController();
  const run=new DripMotion(f.c,t.value,{estimatedPrintTime:()=>0}).run(1,2,abort.signal,mode==='timeout'?15:1000);
  const rejected=assert.rejects(run,mode==='timeout'?/timed out/:/injected/);
  if(mode==='cancel')abort.abort(new Error('injected cancellation'));if(mode==='fault')t.reject(new Error('injected MCU fault'));
  await rejected;assert.equal(f.stops,1);assert.equal(t.stops,1);assert.equal(f.batches.length,0);
 }
});
test('cancellation fences a pending commit and late completion cannot generate the next segment',async()=>{
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});
 using f=await fixture(async b=>{if(b.generatedUntil!>1){entered();await held;}});const t=triggers(),abort=new AbortController();
 const run=new DripMotion(f.c,t.value,{estimatedPrintTime:()=>1}).run(1,2,abort.signal),rejected=assert.rejects(run,/cancelled/);
 await started;abort.abort(new Error('cancelled'));await rejected;assert.equal(f.stops,1);release();await new Promise<void>(r=>setImmediate(r));assert.equal(f.batches.length,1);assert.equal(f.c.status.busy,false);
});
test('unarmed ownership and invalid MCU time stop all; invalid boundaries do not mutate coordinator',async()=>{
 using f=await fixture();const t=triggers();
 await assert.rejects(new DripMotion(f.c,t.value,{estimatedPrintTime:()=>1}).run(.9,2,signal()),/boundary/);assert.equal(f.stops,0);
 t.value.status.armed=false;
 await assert.rejects(new DripMotion(f.c,t.value,{estimatedPrintTime:()=>1}).run(1,2,signal()),/armed/);assert.equal(f.stops,1);
 using other=await fixture();await assert.rejects(new DripMotion(other.c,triggers().value,{estimatedPrintTime:()=>NaN}).run(1,2,signal()),/MCU time/);assert.equal(other.stops,1);
});
import {serialClock} from '../src/protocol/serial-queue.ts';
import {HomingTriggerGroup} from '../src/homing/trigger-group.ts';
import {HomingTriggerSet as TriggerSet} from '../src/homing/trigger-set.ts';
import {HomingRecovery} from '../src/homing/recovery.ts';
import {recoveryFixture} from './helpers/homing-recovery.ts';
test('native trigger notification ends drip before recovery retires and resets the same generation',async()=>{
 const f=await recoveryFixture(1);let group:HomingTriggerGroup|undefined,recovered:Awaited<ReturnType<HomingRecovery['recover']>>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const startClock=f.sessions[0].clock.sync.getClock(serialClock.now()+.15),start=Number(startClock)/1e6;
  const sampling=f.options.endstop.home({printTime:start,sampleTime:.000015,sampleCount:4,restTime:.001,trsyncOid:8},t=>BigInt(Math.round(t*1e6)));
  const q=f.options.bindings[0].queue;q.appendRaw(new Float64Array([start,0,1,0,0,0,0,1,0,0,10,10,0]));await f.options.coordinator.advance(start);
  group=new HomingTriggerGroup(f.options.members,0,f.options.endstop,sampling,[startClock],.25);
  const set=new TriggerSet([group]);f.options.sampling=sampling;f.options.release=()=>set.release();
  const recovery=new HomingRecovery(f.options);await set.arm(signal());
  timer=setTimeout(()=>{f.fs[0].setEndstopState({homing:0,pin_value:0,next_clock:Number(startClock+sampling.restTicks)});f.fs[0].emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:Number(startClock)});},170);
  const result=await new DripMotion(f.options.coordinator,set,{estimatedPrintTime:()=>{f.sessions[0].assertActive();return f.options.bindings[0].stepper.printTimeAtClock(f.sessions[0].clock.sync.getClock(serialClock.now()));}}).run(start,start+1,signal());
  assert.equal(result.reason,'triggered');assert(result.generatedUntil>start&&result.generatedUntil<start+1);
  recovered=await recovery.recover(signal());assert.equal(recovered.stop.hitClock,startClock);assert.equal(f.options.coordinator.status.retired,true);assert.equal(f.stops,0);
 }finally{clearTimeout(timer);group?.release();recovered?.motion.dispose();await f.close();}
});
test('a competing producer during the buffer wait cannot be mistaken for normal completion',async()=>{
 using f=await fixture();const t=triggers();const run=new DripMotion(f.c,t.value,{estimatedPrintTime:()=>0}).run(1,2,signal()),rejected=assert.rejects(run,/ownership changed/);
 await new Promise<void>(r=>setImmediate(r));await f.c.advance(1.05);t.resolve();await rejected;assert.equal(f.stops,1);assert.equal(t.stops,1);
});
