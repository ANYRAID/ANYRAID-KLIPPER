import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
const plan={names:['front','right','rear'],thread:'CW-M3' as const,points:[[50,0],[50.01,0],[50,.01]] as [number,number][],horizontalHeight:1,travelSpeed:10};
for(const failure of [false,true])test(`native screw measurement bypasses old compensation and preserves it on failure=${failure}`,async()=>{
 const t=await nativeLinearFixture(0,()=>false,false,undefined,false,false,false,{z_offset:'0',x_offset:'2',y_offset:'-3'},undefined,undefined,false,undefined,{x_adjust:'.001',z_adjust:'.2'}),s=new AbortController().signal,handled=new Set<unknown>();let hits=0;
 const timer=setInterval(()=>{
  const output=t.f.fw.outputs,arm=output.find(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0&&!handled.has(m));
  if(!arm){if(hits&&output.findLastIndex(m=>m.name==='reset_step_clock')>output.findLastIndex(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0))t.f.fw.setTriggerReason(2,8);return;}
  const hit=Number(arm.parameters.clock)+50000;if(t.f.options.members[0].session.clock.sync.getClock(serialClock.now())<BigInt(hit+1000))return;
  handled.add(arm);hits++;t.f.fw.setTriggerReason(1,8);t.f.fw.setStepperPosition(2,-15*hits);t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:hit+Number(arm.parameters.rest_ticks)},7);t.f.fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:hit});
 },1);
 try{
  t.kinematics.markHomed([0,1,2]);await t.port.forcePosition([50,0,1,0],s);const old=t.port.bedTiltStatus;assert.equal(t.port.position()[2],.75);
  if(failure){await assert.rejects(t.port.measureScrewsTilt({...plan,points:[[50,0],[50.01,0],[201,1]]},0,s),/range/);assert.deepEqual(t.port.bedTiltStatus,old);assert.equal(hits,0);assert(t.port.status.failed);assert.equal(t.kinematics.status.homedAxes,'');}
  else{const result=await t.port.measureScrewsTilt(plan,0,s);assert.equal(hits,3);assert.deepEqual(result.samples.map(p=>p.slice(0,2)),[[52,-3],[52.01,-3],[52,-2.99]]);assert(result.samples.every(p=>p[2]===.88));assert.equal(result.base,0);assert.equal(result.error,false);assert(result.results.every(r=>r.adjust==='00:00'));assert.equal(t.port.homingPosition()[2],1);assert.deepEqual(t.port.bedTiltStatus,old);assert.equal(t.port.status.failed,false);t.port.move([50,0,.2,0],5);assert(Math.abs(t.port.homingPosition()[2]-.45)<1e-8);await t.port.drain(s);}
 }finally{clearInterval(timer);await t.close();}
});
