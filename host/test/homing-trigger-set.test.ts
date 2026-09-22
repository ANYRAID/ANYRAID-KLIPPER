import {test} from 'node:test';
import assert from 'node:assert/strict';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {TriggerSyncProtocol} from '../src/inputs/trsync.ts';
import {EndstopProtocol} from '../src/inputs/endstop.ts';
import {HomingTriggerGroup} from '../src/homing/trigger-group.ts';
import {HomingTriggerSet} from '../src/homing/trigger-set.ts';
import {recoveryFixture} from './helpers/homing-recovery.ts';
const signal=()=>new AbortController().signal;
async function fixture(shared=false,overlap=false,safety?:()=>Promise<void>){
 const f=await recoveryFixture(shared?1:2,safety),groups:HomingTriggerGroup[]=[];
 for(let i=0;i<2;i++){
  const original=f.options.members[shared?0:i],session=original.session,chip={},trigger=shared&&i?new TriggerSyncProtocol(session.dictionary,6):original.trigger,endstop=new EndstopProtocol(chip,session.dictionary,shared&&i?5:7,{chip,chipName:'mcu',pin:'PA0',invert:0,pullup:1}),member={...original,trigger,queue:shared&&i?session.commandQueue():original.queue,steppers:[{oid:shared&&i&&!overlap?2:1,inverted:false}]};
  const clock=session.clock.sync.getClock(serialClock.now()+.3),sampling=endstop.home({printTime:Number(clock)/1e6,sampleTime:.000015,sampleCount:4,restTime:.001,trsyncOid:trigger.oid},t=>BigInt(Math.round(t*1e6)));
  groups.push(new HomingTriggerGroup([member],0,endstop,sampling,[clock],.25));
 }
 return {f,groups,async close(){for(const g of groups)g.release();await f.close();}};
}
test('all independent endstops must complete, with stable input-order outcomes',async()=>{
 const x=await fixture();try{
  const set=new HomingTriggerSet(x.groups);await set.arm(signal());let complete=false;void set.completion.then(()=>{complete=true;});
  x.f.fs[1].emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:0});await x.groups[1].completion;await new Promise(r=>setImmediate(r));assert.equal(complete,false);assert.equal(set.status.remaining,1);
  x.f.fs[0].emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:3,clock:0});const results=await set.wait(signal());assert.deepEqual(results,[{group:0,member:0,reason:3},{group:1,member:0,reason:1}]);assert(Object.isFrozen(results));assert.equal(x.f.stops,0);set.release();
 }finally{await x.close();}
});
test('failure after another group completed still stops all participating MCUs',async()=>{
 const x=await fixture();try{const set=new HomingTriggerSet(x.groups);await set.arm(signal());x.f.fs[0].emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:0});await x.groups[0].completion;
  const failed=assert.rejects(set.wait(signal()));x.f.fs[1].emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:4,clock:0});await failed;assert.equal(set.status.failed,true);assert.equal(x.f.stops,2);
 }finally{await x.close();}
});
test('wait cancellation after partial completion stops the remaining group and completed group',async()=>{
 const x=await fixture();try{const set=new HomingTriggerSet(x.groups);await set.arm(signal());x.f.fs[0].emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:0});await x.groups[0].completion;
  const abort=new AbortController(),wait=set.wait(abort.signal),failed=assert.rejects(wait,/cancel all/);abort.abort(new Error('cancel all'));await failed;assert.equal(x.f.stops,2);
 }finally{await x.close();}
});
test('independent groups on one MCU keep OID completion routes separate',async()=>{
 const x=await fixture(true);try{const set=new HomingTriggerSet(x.groups);await set.arm(signal());x.f.fs[0].emit('trsync_state',{oid:6,can_trigger:0,trigger_reason:1,clock:0});await x.groups[1].completion;assert.equal(set.status.remaining,1);x.f.fs[0].emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:0});assert.equal((await set.wait(signal())).length,2);set.release();assert.equal(x.f.stops,0);}finally{await x.close();}
});
test('duplicate groups and overlapping stepper ownership reject before arming',async()=>{
 const x=await fixture(true,true);try{assert.throws(()=>new HomingTriggerSet([x.groups[0],x.groups[0]]));assert.throws(()=>new HomingTriggerSet(x.groups));assert.equal(x.f.stops,0);assert(!x.f.fs[0].outputs.some(o=>o.name==='trsync_start'));}finally{await x.close();}
});
test('failure notification is immediate while bounded cleanup retains late safety errors',async()=>{
 let fail!:(error:Error)=>void;const safety=new Promise<void>((_,reject)=>{fail=reject;}),x=await fixture(true,false,()=>safety);
 try{const set=new HomingTriggerSet(x.groups,20),stopping=set.stop(new Error('group failure')),bounded=assert.rejects(stopping,/timed out/);await assert.rejects(set.completion,/group failure/);await bounded;assert.equal(set.status.cleanupPending,true);assert.equal(x.f.stops,1);
  fail(new Error('late physical stop failure'));await x.f.sessions[0].stop().catch(()=>{});await new Promise(r=>setImmediate(r));assert.equal(set.status.cleanupPending,false);assert(set.status.cleanupErrors.length>0);
 }finally{fail(new Error('test cleanup'));await x.close();}
});
test('a completed group can still report a later MCU fault while another group is homing',async()=>{
 const x=await fixture();try{const set=new HomingTriggerSet(x.groups);await set.arm(signal());x.f.fs[0].emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:0});await x.groups[0].completion;
  const failed=assert.rejects(set.wait(AbortSignal.timeout(150)),/trigger stopped/);x.f.fs[0].emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:4,clock:0});await failed;assert.equal(x.f.stops,2);
 }finally{await x.close();}
});
test('a previously completed set cannot report healthy success after a later member fault',async()=>{
 const x=await fixture();try{const set=new HomingTriggerSet(x.groups);await set.arm(signal());for(const fw of x.f.fs)fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:0});await set.wait(signal());
  x.f.fs[0].emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:4,clock:0});await assert.rejects(x.groups[0].failure);await assert.rejects(set.wait(signal()),/trigger stopped/);assert.equal(x.f.stops,2);
 }finally{await x.close();}
});
test('cancellation at the completion notification cannot publish a stale successful wait',async()=>{
 const x=await fixture();try{const set=new HomingTriggerSet(x.groups);await set.arm(signal());const abort=new AbortController(),waiting=set.wait(abort.signal),cancelled=assert.rejects(waiting,/cancel at completion/);
  void set.completion.then(()=>abort.abort(new Error('cancel at completion')));for(const fw of x.f.fs)fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:0});await cancelled;assert.equal(x.f.stops,2);
 }finally{await x.close();}
});
