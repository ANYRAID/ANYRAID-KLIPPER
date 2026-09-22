import test from 'node:test';
import assert from 'node:assert/strict';
import {HomingRetractExecution} from '../src/homing/retract-execution.ts';
import {LinearKinematics} from '../src/kinematics/linear.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {rebuiltFixture} from './helpers/rebuilt-motion.ts';
const kin=()=>new LinearKinematics({kind:'cartesian',ranges:[[0,200],[0,200],[0,200]],maxVelocity:100,maxAccel:1000,maxZVelocity:5,maxZAccel:100});
const signal=()=>new AbortController().signal;
test('native retreat from recovered coordinates preserves extrusion and waits for MCU completion',async()=>{
 const f=await rebuiltFixture();try{
  const generation=await bindRebuiltMotion(f.options),k=kin(),move=new HomingRetractExecution(generation,k);
  assert.deepEqual(await move.run([51,0,0,2],10,0,signal()),[51,0,0,2]);
  assert.equal(generation.motion.bindings[0].history.status.lastPlannedPosition,200n);assert.equal(generation.motion.bindings[1].history.status.lastPlannedPosition,20n);
  assert.equal(f.fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===3).reduce((n,m)=>n+Number(m.parameters.count),0),100);
  assert.equal(f.fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===4).length,0);
  assert(f.options.members[0].session.clock.sync.lastClock>generation.motion.bindings[0].stepper.clockAt(generation.coordinator.status.committedTime));
  assert.equal(k.status.homedAxes,'');assert.equal(f.stops,0);await assert.rejects(move.run([52,0,0,2],10,0,signal()),/single use/);assert.equal(f.stops,0);
 }finally{await f.close();}
});
test('privileged retract enforces Z limits without granting ordinary homing authority',()=>{
 for(const kind of ['cartesian','corexy','corexz'] as const){const k=new LinearKinematics({kind,ranges:[[0,200],[0,200],[0,200]],maxVelocity:100,maxAccel:1000,maxZVelocity:5,maxZAccel:100});
  const move=k.planHomingRetract([0,0,-.01,2],[0,0,1,2],80,2);assert.equal(move.maxCruiseV2,25);assert.equal(move.accel,100);assert.throws(()=>k.check(move),/Must home/);assert.equal(k.status.homedAxes,'');
  for(const end of [[1,0,1,2],[0,0,1,3],[0,0,201,2],[0,0,-.01,2]])assert.throws(()=>k.planHomingRetract([0,0,-.01,2],end,10,2));
 }
});
test('invalid retreat cannot emit a partial path or authorize axes',async()=>{
 const f=await rebuiltFixture();try{const g=await bindRebuiltMotion(f.options),k=kin();await assert.rejects(new HomingRetractExecution(g,k).run([51,1,0,2],10,0,signal()),/one linear axis/);assert.equal(f.fw.motion.length,0);assert.equal(f.stops,1);assert.equal(k.status.homedAxes,'');}finally{await f.close();}
});
test('pre-cancelled retreat closes the current generation without generating steps',async()=>{
 const f=await rebuiltFixture();try{const g=await bindRebuiltMotion(f.options),a=new AbortController();a.abort(new Error('cancel retreat'));await assert.rejects(new HomingRetractExecution(g,kin()).run([51,0,0,2],10,0,a.signal),/cancel retreat/);assert.equal(f.fw.motion.length,0);assert.equal(f.stops,1);}finally{await f.close();}
});
test('retract timeout after native generation fences the group before any later seek',async()=>{
 const f=await rebuiltFixture();try{const g=await bindRebuiltMotion(f.options);await assert.rejects(new HomingRetractExecution(g,kin()).run([51,0,0,2],10,0,signal(),20),/timed out/);assert.equal(f.stops,1);assert.equal(g.coordinator.status.failed,true);}finally{await f.close();}
});

test('delayed retreat rejects expired recovered time before publishing native steps',async()=>{
 const f=await rebuiltFixture();try{const g=await bindRebuiltMotion(f.options);await new Promise(r=>setTimeout(r,250));await assert.rejects(new HomingRetractExecution(g,kin()).run([51,0,0,2],10,0,signal()),/baseline expired/);assert.equal(f.stops,1);assert.equal(f.fw.motion.length,0);}finally{await f.close();}
});

test('calibration drift after binding cannot change the recovered retreat time mapping',async()=>{
 const f=await rebuiltFixture();try{const g=await bindRebuiltMotion(f.options);g.coordinator.calibrateClock(['x'],0,1000001);await assert.rejects(new HomingRetractExecution(g,kin()).run([51,0,0,2],10,0,signal()),/calibration changed/);assert.equal(f.stops,1);assert.equal(f.fw.motion.length,0);}finally{await f.close();}
});
