import test from 'node:test';
import assert from 'node:assert/strict';
import {planHomingGroups,type HomingGroupConfig} from '../src/homing/group-plan.ts';
import {prepareHomingTrajectory} from '../src/homing/prepare-trajectory.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {rebuiltFixture} from './helpers/rebuilt-motion.ts';
import {LinearKinematics} from '../src/kinematics/linear.ts';
import {HomingMoveExecution} from '../src/homing/move-execution.ts';
import {HomingRetractExecution} from '../src/homing/retract-execution.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
const kin=()=>new LinearKinematics({kind:'cartesian',ranges:[[0,200],[0,200],[0,200]],maxVelocity:100,maxAccel:1000,maxZVelocity:5,maxZAccel:100});
const signal=()=>new AbortController().signal;
function configs(f:Awaited<ReturnType<typeof rebuiltFixture>>):HomingGroupConfig[]{return [{members:[{physicalMember:0,trigger:f.options.members[0].trigger,emitters:['x','e']}],primary:0,endstop:f.endstop,expireTimeout:.25},{members:[{physicalMember:0,trigger:f.secondTrigger,emitters:['x2']}],primary:0,endstop:f.secondEndstop,expireTimeout:.25}];}
test('two independent endstops on one MCU recover logical indices then rebind the physical group',async()=>{
 const f=await rebuiltFixture(true);let recovered:Awaited<ReturnType<HomingMoveExecution['run']>>|undefined;
 try{
  const g=await bindRebuiltMotion(f.options),k=kin(),p=await prepareHomingTrajectory(g,k,[51,0,0,2],10,0,signal());
  const plan=planHomingGroups(g,f.emitters,p,configs(f));assert.deepEqual(plan.emitters.map(e=>[e.id,e.member]),[['x',0],['e',0],['x2',1]]);
  f.fw.setTriggerReason(3,8);f.fw.setTriggerReason(3,9);f.fw.setStepperPosition(3,200);f.fw.setStepperPosition(5,400);
  using move=new HomingMoveExecution({...plan,coordinator:g.coordinator,bindings:g.motion.bindings,startTime:p.startTime,endTime:p.endTime,locate:()=>({queues:[{id:'xyz',position:[51,0,0]},{id:'e',position:[2,0,0]}],printTime:Number(f.options.members[0].session.clock.sync.getClock(serialClock.now()))/1e6+.2})});
  recovered=await move.run(signal());assert.deepEqual(recovered.missingHits,[0,1]);assert.deepEqual(recovered.offsets.map(o=>[o.member,o.oid,o.halt]),[[0,3,200n],[0,4,20n],[1,5,400n]]);
  const motion=plan.restorePhysicalMembers(recovered.motion);assert(motion.bindings.every(b=>b.member===0));assert.equal(motion.bindings[2].history.status.lastPlannedPosition,400n);
  const next=await bindRebuiltMotion({...f.options,motion,routes:[{queue:motion.bindings[0].queue},{queue:motion.bindings[1].queue,extrusionAxis:3}],position:[51,0,0,2]});
  await new HomingRetractExecution(next,k).run([52,0,0,2],10,0,signal());assert.equal(motion.bindings[0].history.status.lastPlannedPosition,300n);assert.equal(motion.bindings[2].history.status.lastPlannedPosition,500n);assert.equal(f.stops,0);assert.equal(k.status.homedAxes,'');
  assert.throws(()=>plan.restorePhysicalMembers({...motion,bindings:motion.bindings.map(b=>({...b,member:99}))}),/member differs/);
 }finally{recovered?.motion.dispose();await f.close();}
});
test('group planning rejects missing, duplicated and overlapping roles before firmware writes',async()=>{
 const f=await rebuiltFixture(true);try{
  const g=await bindRebuiltMotion(f.options),p=await prepareHomingTrajectory(g,kin(),[51,0,0,2],10,0,signal()),before=f.fw.outputs.length;
  const cs=configs(f);assert.throws(()=>planHomingGroups(g,f.emitters,p,cs.slice(0,1)),/omit/);
  assert.throws(()=>planHomingGroups(g,f.emitters,p,[cs[0],{...cs[1],members:[{...cs[1].members[0],emitters:['x']}]}]),/ownership/);
  assert.throws(()=>planHomingGroups(g,f.emitters,p,[cs[0],{...cs[1],endstop:f.endstop}]),/overlap/);
  assert.throws(()=>planHomingGroups(g,f.emitters,p,[cs[0],{...cs[1],members:[{...cs[1].members[0],physicalMember:1}]}]),/physical/);
  assert.equal(f.fw.outputs.length,before);assert.equal(f.stops,0);
 }finally{await f.close();}
});
