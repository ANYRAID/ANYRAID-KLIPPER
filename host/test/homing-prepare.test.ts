import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareHomingTrajectory} from '../src/homing/prepare-trajectory.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {rebuiltFixture} from './helpers/rebuilt-motion.ts';
import {LinearKinematics} from '../src/kinematics/linear.ts';
import {HomingMoveExecution} from '../src/homing/move-execution.ts';
import {homingEndstopSampling} from '../src/homing/endstop-rate.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {inputShaper} from '../src/motion/shaper.ts';
const kin=()=>new LinearKinematics({kind:'cartesian',ranges:[[0,200],[0,200],[0,200]],maxVelocity:100,maxAccel:1000,maxZVelocity:5,maxZAccel:100});
const signal=()=>new AbortController().signal;
test('prepared source performs full native seek and no-hit recovery with stationary filter padding',async()=>{
 for(const filtered of [false,true]){
  const f=await rebuiltFixture();let result:Awaited<ReturnType<HomingMoveExecution['run']>>|undefined;
  try{
   const g=await bindRebuiltMotion(f.options),[x,e]=g.motion.bindings,k=kin(),shaper=inputShaper('mzv',40,.1);
   if(filtered){x.stepper.configureShapers({x:shaper});e.stepper.configurePressureAdvance(.05,.04);}
   const before=f.fw.motion.length,p=await prepareHomingTrajectory(g,k,[51,0,0,2],10,0,signal());
   assert.equal(f.fw.motion.length,before);assert.equal(g.coordinator.status.generatedTime,p.startTime);assert.equal(g.source.status.retired,true);assert.throws(()=>g.source.append([]),/retired/);
   assert.equal(x.history.status.throughClock,x.stepper.clockAt(p.startTime));assert(p.movementStart>p.startTime+.001);assert(p.endTime>p.nominalEnd);assert(p.sourceUntil-p.endTime>=x.stepper.scanWindow.future);
   const sampling=homingEndstopSampling(f.endstop,x.stepper,8,p.startTime,p.startPosition,p.endPosition,10,[{stepper:x.stepper,stepDistance:.01}]);
   f.fw.setTriggerReason(3,8);f.fw.setStepperPosition(3,200);f.fw.setStepperPosition(4,20);
   using move=new HomingMoveExecution({coordinator:g.coordinator,bindings:g.motion.bindings,emitters:f.emitters.map(em=>filtered?{...em,...em.id==='x'?{shapers:{x:shaper}}:{pressureAdvance:{advance:.05,smoothTime:.04}}}:em),groups:[{members:f.options.members,primary:0,endstop:f.endstop,sampling,startClocks:[x.stepper.clockAt(p.startTime)],expireTimeout:.25}],histories:g.motion.bindings.map(b=>({member:b.member,oid:b.oid,history:b.history})),startTime:p.startTime,endTime:p.endTime,locate:()=>({queues:[{id:'xyz',position:[51,0,0]},{id:'e',position:[2,0,0]}],printTime:Number(f.options.members[0].session.clock.sync.getClock(serialClock.now()))/1e6+.2})});
   result=await move.run(signal());assert.equal(result.drip.reason,'exhausted');assert.deepEqual(result.missingHits,[0]);assert.equal(result.offsets[0].trigger,200n);assert.equal(result.offsets[1].trigger,20n);
   assert.equal(f.fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===3).reduce((n,m)=>n+Number(m.parameters.count),0),100);assert.equal(k.status.homedAxes,'');assert.equal(f.stops,0);
  }finally{result?.motion.dispose();await f.close();}
 }
});
test('invalid preparation does not queue motion and stops the owned generation',async()=>{
 const f=await rebuiltFixture();try{const g=await bindRebuiltMotion(f.options);await assert.rejects(prepareHomingTrajectory(g,kin(),[51,0,0,3],10,0,signal()),/one linear axis/);assert.equal(f.fw.motion.length,0);assert.equal(f.stops,1);}finally{await f.close();}
});
test('cancelled preparation and repeated producer transfer cannot publish a second trajectory',async()=>{
 for(const cancelled of [false,true]){const f=await rebuiltFixture();try{const g=await bindRebuiltMotion(f.options),a=new AbortController();
  if(cancelled)a.abort(new Error('cancel preparation'));else await prepareHomingTrajectory(g,kin(),[51,0,0,2],10,0,signal());
  await assert.rejects(prepareHomingTrajectory(g,kin(),[51,0,0,2],10,0,a.signal),/cancel preparation|unused/);assert.equal(f.stops,1);assert.equal(f.fw.motion.length,0);
 }finally{await f.close();}}
});
