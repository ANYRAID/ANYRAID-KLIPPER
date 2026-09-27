import test from 'node:test';
import type {HomingPass} from '../src/homing/linear-command.ts';
import assert from 'node:assert/strict';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import {EndstopPhaseAlignment} from '../src/homing/endstop-phase.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
const signal=()=>new AbortController().signal;
for(const unknown of [false,true])test(`native final homing phase ${unknown?'unknown stops before homing authority':'uses the trigger count and rebases the coordinate'}`,async()=>{
 const alignment=new EndstopPhaseAlignment({microsteps:16,stepDistance:.01,triggerPhase:{phase:35,phases:64}});
 const t=await nativeLinearFixture(0,()=>false,false,undefined,false,false,false,undefined,undefined,[{id:'x',alignment,offset:()=>unknown?null:0}]);let sent=false;let last:HomingPass|undefined;const home=t.port.home.bind(t.port);t.port.home=async(...args)=>{last=await home(...args);return last;};
 const timer=setInterval(()=>{
  // Fresh stop-confirmation after correction uses reason 2 rather than a stale hit.
  if(t.port.status.phase!=='seek'){t.f.fw.setTriggerReason(2,8);return;}
  const arm=t.f.fw.outputs.find(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0);if(!arm||sent)return;
  const clock=BigInt(Number(arm.parameters.clock)),now=t.f.options.members[0].session.clock.sync.getClock(serialClock.now());if(now<clock)return;sent=true;
  t.f.fw.setStepperPosition(3,102);t.f.fw.setTriggerReason(1,8);t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:Number(clock)+Number(arm.parameters.rest_ticks)},7);
  t.f.fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:Number(clock)});
 },1);
 try{
  if(unknown){await assert.rejects(t.command.home([0],signal()),/Unknown/);assert.equal(t.kinematics.status.homedAxes,'');assert(t.port.status.failed);assert.equal(alignment.status.last,null);}
  else{await t.command.home([0],signal());assert(sent);assert.equal(alignment.status.last?.mcuPosition,100n);assert.equal(alignment.status.last?.phase,36);assert.equal(t.port.position()[0],51.03);assert.equal(t.coordinates.state.position[0],51.03);assert.equal(t.kinematics.status.homedAxes,'x');assert.equal(t.f.stops,0);await assert.rejects(t.port.finishHoming(last!,0,51,signal()),/Stale/);assert(t.port.status.failed);assert.equal(t.kinematics.status.homedAxes,'');}
 }finally{clearInterval(timer);await t.close();}
});
