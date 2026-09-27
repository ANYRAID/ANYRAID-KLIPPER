import assert from 'node:assert/strict';
import {nativeLinearFixture} from '../test/helpers/native-linear-port.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const t=await nativeLinearFixture(),signal=new AbortController().signal;let sent=false;
 const timer=setInterval(()=>{const arm=t.f.fw.outputs.find(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0);if(!arm||sent)return;const hit=Number(arm.parameters.clock)+50000;if(t.f.options.members[0].session.clock.sync.getClock(serialClock.now())<BigInt(hit+1000))return;sent=true;t.f.fw.setTriggerReason(1,8);t.f.fw.setStepperPosition(2,-15);t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:hit+Number(arm.parameters.rest_ticks)},7);t.f.fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:hit});},1);
 try{
  t.kinematics.markHomed([0,1,2]);await t.port.forcePosition([50,0,1,2],signal);const used=process.cpuUsage(),start=performance.now();
  if(mode){const result=await t.port.probeZ(0,5,t.groups,signal);assert.deepEqual(result.trigger,[50,0,.88,2]);assert.deepEqual(result.halt,[50,0,.85,2]);}
  else{await t.port.forcePosition([50,0,1,2],signal);await t.port.home([50,0,0,2],5,2,signal);assert.equal(t.port.homingPosition()[2],-.03);}
  const elapsed=performance.now()-start,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000);}assert(sent);assert.equal(t.f.stops,0);
 }finally{clearInterval(timer);await t.close();}
}
const stats=(a:number[])=>{a.sort((x,y)=>x-y);return {medianMs:a[5],p95Ms:a[10]};},home={wall:stats(wall[0]),cpu:stats(cpu[0])},probe={wall:stats(wall[1]),cpu:stats(cpu[1])};console.log(JSON.stringify({node:process.version,warmups:3,samples:11,home,probe,scope:'Native owner drain/rebase and triggered Z seek with generation adoption; alternate explicit home rebase versus owned probe. Simulated MCU, fixture setup excluded.'}));assert(probe.wall.medianMs<=home.wall.medianMs*1.25+5);assert(probe.cpu.medianMs<=home.cpu.medianMs*1.5+2);assert(probe.cpu.medianMs<25);
