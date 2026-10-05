import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
for(const mode of ['flat','single','retry','exhausted','diverging','invalid'])test(`automatic native Z tilt probe and adjustment mode=${mode}`,async()=>{
 const t=await nativeLinearFixture(0,()=>false,false,undefined,true,false,false,{z_offset:'0',x_offset:'2',y_offset:'-3'},undefined,undefined,false,undefined,undefined,2),s=new AbortController().signal,handled=new Set<unknown>();let hits=0,count=0;
 const plan={points:[[50,0],[50.01,0],[50,.01]] as [number,number][],horizontalHeight:1,travelSpeed:10,motors:[{id:'z',x:52,y:-3},{id:'z1',x:52.01,y:-3},{id:'z2',x:52,y:-2.99}],maximumTravel:.5,retries:mode==='single'?0:mode==='diverging'?3:1,retryTolerance:.000001};
 const timer=setInterval(()=>{
  const output=t.f.fw.outputs,arm=output.find(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0&&!handled.has(m));
  if(!arm){if(hits&&output.findLastIndex(m=>m.name==='reset_step_clock')>output.findLastIndex(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0))t.f.fw.setTriggerReason(2,8);return;}
  const pass=Math.floor(hits/3),point=hits%3,variation=mode==='flat'||mode==='retry'&&pass>0?0:point*(mode==='diverging'?pass+1:1);
  const hit=Number(arm.parameters.clock)+50000+variation*4000;if(BigInt(t.f.fw.currentClock())<BigInt(hit+1000))return;
  handled.add(arm);hits++;count-=15+variation;t.f.fw.setTriggerReason(1,8);for(const oid of [2,10,11])t.f.fw.setStepperPosition(oid,count);
  t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:hit+Number(arm.parameters.rest_ticks)},7);t.f.fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:hit});
 },1);
 try{
  t.kinematics.markHomed([0,1,2]);await t.port.forcePosition([50,0,1,2],s);
  if(mode==='invalid')plan.points=plan.points.map(([x,y])=>[x+200,y]);
  if(['exhausted','diverging','invalid'].includes(mode)){
   await assert.rejects(t.port.calibrateZTilt(plan,0,s),mode==='invalid'?/range/:mode==='diverging'?/increasing/:/retry limit/);
   assert.equal(hits,mode==='invalid'?0:mode==='diverging'?9:6);assert.equal(t.port.zTiltStatus.applied,false);assert(t.port.status.failed);assert.equal(t.kinematics.status.homedAxes,'');
  }else{
   const result=await t.port.calibrateZTilt(plan,0,s);assert.equal(result.passes,mode==='retry'?2:1);assert.equal(hits,result.passes*3);assert.equal(result.toleranceSatisfied,mode!=='single');assert.equal(result.measuredRange<=plan.retryTolerance,mode!=='single');
   assert.deepEqual(result.samples.map(p=>p.slice(0,2)),[[52,-3],[52.01,-3],[52,-2.99]]);assert.equal(t.port.zTiltStatus.applied,true);assert.equal(t.port.status.failed,false);
   await t.port.releaseMotors(s);assert.equal(t.port.zTiltStatus.applied,false);
  }
 }finally{clearInterval(timer);await t.close();}
});
