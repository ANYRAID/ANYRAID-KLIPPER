import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {BLTouchDevice} from '../src/homing/bltouch-device.ts';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {FrameDecoder} from '../src/protocol/codec.ts';
const signal=()=>new AbortController().signal;
for(const {home,cancel=false} of [{home:false},{home:true},{home:true,cancel:true}])test(`native ${home?'probe Z home':'multi-sample probe'} refreshes motion baseline after device waits (cancel=${cancel})`,async()=>{
 const pwm:{duty:number;time:number}[]=[];let checks=0;const abort=new AbortController();
 const t=await nativeLinearFixture(0,()=>false,false,undefined,false,false,false,{pin:'PA13',z_offset:'1.25',samples:'2',samples_tolerance:'10'},undefined,undefined,home,async(_endstop,stop)=>{
  const device=new BLTouchDevice({clockAt:t=>BigInt(Math.trunc(t*1e6)),printAt:c=>Number(c)/1e6,secondsToClock:t=>BigInt(Math.trunc(t*1e6)),estimatedPrintTime:()=>serialClock.now(),motionPrintTime:()=>serialClock.now(),async waitUntil(time,s){while(serialClock.now()<time)await delay(2,undefined,{signal:s});},async verifyState(o,s){checks++;if(cancel&&checks===2)abort.abort(Error('cancel device preparation'));while(serialClock.now()<o.until)await delay(2,undefined,{signal:s});return true;},async setPWM(time,duty){pwm.push({time,duty});},stop},{pinMoveTime:.3,stowOnEachSample:true,touchMode:false,pinUpNotTriggered:true,pinUpTouchTriggered:true,outputMode:null});await device.initialize(signal());return device;
 });let hits=0;const decoder=new FrameDecoder();let sequence=1;
 t.f.fw.peer.on('data',chunk=>{for(const frame of decoder.push(typeof chunk==='string'?Buffer.from(chunk):chunk)){if((frame[1]&15)!==sequence)continue;sequence=(sequence+1)&15;for(const c of t.f.fw.dictionary.parseFrame(frame))if(c.name==='trsync_start'&&c.parameters.report_ticks===0)t.f.fw.setTriggerReason(2,Number(c.parameters.oid));}});
// Emit a synthetic endstop hit only after the firmware clock reaches it.
// The host estimator may lead this clock; it cannot authorize a fake hit.
 const timer=setInterval(()=>{const arm=t.f.fw.outputs.filter(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0)[hits];if(!arm)return;const clock=Number(arm.parameters.clock)+30000;if(BigInt(t.f.fw.currentClock())<BigInt(clock))return;hits++;t.f.fw.setStepperPosition(2,-5*hits);t.f.fw.setTriggerReason(1,8);t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:clock+Number(arm.parameters.rest_ticks)},7);t.f.fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock});},1);
 try{
  t.kinematics.markHomed(home?[0,1]:[0,1,2]);
  if(cancel){await assert.rejects(t.command.home([2],abort.signal),/cancel device preparation/);assert.equal(hits,0);assert.equal(t.kinematics.status.homedAxes,'');assert.equal(t.device!.status.phase,'failed');assert.equal(t.f.stops,1);return;}
  if(home)await t.command.home([2],signal());else{await t.port.forcePosition([10,10,5,2],signal());const result=await t.port.measureProbe(0,signal());assert.equal(result.attempts,2);assert(result.position.every(Number.isFinite));}
  assert.equal(hits,home?1:2);assert.equal(t.device!.status.phase,'idle');assert.equal(t.device!.status.deployed,false);assert.equal(t.kinematics.status.homedAxes,'xyz');assert(checks>=3);assert(pwm.some(p=>p.duty===.000650/.020));assert.equal(pwm.at(-1)!.duty,0);
  const target=[...t.port.position()];target[2]+=.1;t.port.move(target,5);await t.port.drain(signal());assert.equal(t.f.stops,0);assert.deepEqual(t.port.position(),target);
 }finally{clearInterval(timer);await t.close();}
});
