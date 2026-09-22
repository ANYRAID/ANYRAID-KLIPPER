import test from 'node:test';
import assert from 'node:assert/strict';
import {LinearHomingSeek} from '../src/homing/linear-seek.ts';
import {LinearKinematics} from '../src/kinematics/linear.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {HomingRetractExecution} from '../src/homing/retract-execution.ts';
import {rebuiltFixture} from './helpers/rebuilt-motion.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
const kin=(kind:'cartesian'|'corexy'='cartesian')=>new LinearKinematics({kind,ranges:[[0,200],[0,200],[0,200]],maxVelocity:100,maxAccel:1000,maxZVelocity:5,maxZAccel:100});
const signal=()=>new AbortController().signal;
async function fixture(){const f=await rebuiltFixture(false,true);try{const generation=await bindRebuiltMotion(f.options),kinematics=kin();const options={generation,kinematics,emitters:f.emitters,kinematicIds:['x','y','z'] as const,groups:[{members:[{physicalMember:0,trigger:f.options.members[0].trigger,emitters:f.emitters.map(e=>e.id)}],primary:0,endstop:f.endstop,expireTimeout:.25}]};return {f,options};}catch(error){await f.close();throw error;}}
test('native seek computes overshoot coordinates from hit history and adopts a usable new generation',async()=>{
 const {f,options}=await fixture();let result:Awaited<ReturnType<LinearHomingSeek['run']>>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const g=options.generation,x=g.motion.bindings[0].stepper,hit=x.clockAt(g.motion.printTime+.052),s=f.options.members[0].session;
  const delay=Math.max(0,Number(hit-s.clock.sync.getClock(serialClock.now()))/1e6+.01)*1000;
  timer=setTimeout(()=>{f.fw.setTriggerReason(1,8);f.fw.setStepperPosition(3,148);f.fw.setEndstopState({homing:0,pin_value:0,next_clock:Number(hit+1000n)},7);f.fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:Number(hit)});},delay);
  const seek=new LinearHomingSeek(options);result=await seek.run([51,0,0,2],10,0,signal());
  assert.equal(result.drip.reason,'triggered');assert.deepEqual(result.missingHits,[]);assert.equal(result.offsets[0].trigger,145n);assert.equal(result.offsets[0].halt,148n);assert.equal(result.offsets[0].overshoot,3n);
  assert(Math.abs(result.position[0]-51.03)<1e-12);assert.deepEqual(result.position.slice(1),[0,0,2]);assert.equal(result.generation.motion.bindings[0].history.status.lastPlannedPosition,148n);
  await new HomingRetractExecution(result.generation,options.kinematics).run([52.03,0,0,2],10,0,signal());assert.equal(result.motion.bindings[0].history.status.lastPlannedPosition,248n);assert.equal(options.kinematics.status.homedAxes,'');assert.equal(f.stops,0);
  await assert.rejects(seek.run([51,0,0,2],10,0,signal()),/single use/);
 }finally{clearTimeout(timer);result?.motion.dispose();await f.close();}
});
test('missing endstop remains explicit while endpoint motion is recovered and rebound',async()=>{
 const {f,options}=await fixture();let result:Awaited<ReturnType<LinearHomingSeek['run']>>|undefined;
 try{f.fw.setTriggerReason(3,8);f.fw.setStepperPosition(3,200);result=await new LinearHomingSeek(options).run([51,0,0,2],10,0,signal());assert.deepEqual(result.missingHits,[0]);assert.deepEqual(result.position,[51,0,0,2]);assert.equal(result.generation.source.status.retired,false);assert.equal(f.stops,0);assert.equal(options.kinematics.status.homedAxes,'');}finally{result?.motion.dispose();await f.close();}
});
test('uncommanded extra-axis displacement refuses coordinate reset and stops the machine',async()=>{
 const {f,options}=await fixture();try{const before=f.fw.outputs.filter(m=>m.name==='reset_step_clock').length;f.fw.setTriggerReason(3,8);f.fw.setStepperPosition(3,200);f.fw.setStepperPosition(4,21);await assert.rejects(new LinearHomingSeek(options).run([51,0,0,2],10,0,signal()),/extra-axis movement/);assert.equal(f.fw.outputs.filter(m=>m.name==='reset_step_clock').length,before);assert.equal(f.stops,1);}finally{await f.close();}
});
test('solver mismatch and cancellation cannot arm a seek',async()=>{
 for(const cancelled of [false,true]){const {f,options}=await fixture();try{const before=f.fw.outputs.length,a=new AbortController();if(cancelled)a.abort(new Error('cancel seek'));await assert.rejects(new LinearHomingSeek({...options,kinematics:cancelled?options.kinematics:kin('corexy')}).run([51,0,0,2],10,0,a.signal),/solvers differ|cancel seek/);assert.equal(f.fw.outputs.length,before);assert.equal(f.stops,1);}finally{await f.close();}}
});

test('in-flight cancellation fences the unified seek and never publishes a replacement',async()=>{
 const {f,options}=await fixture();let timer:ReturnType<typeof setTimeout>|undefined;
 try{const a=new AbortController(),seek=new LinearHomingSeek(options),running=seek.run([51,0,0,2],10,0,a.signal),rejected=assert.rejects(running,/cancel running seek/);timer=setTimeout(()=>a.abort(new Error('cancel running seek')),25);await rejected;assert.equal(f.stops,1);assert.equal(options.generation.coordinator.status.failed,true);assert.equal(seek.status.cleanupPending,false);}finally{clearTimeout(timer);await f.close();}
});
