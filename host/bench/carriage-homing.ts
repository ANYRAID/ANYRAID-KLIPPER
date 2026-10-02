import assert from 'node:assert/strict';
import {nativeCarriageFixture} from '../test/helpers/native-carriage-port.ts';
import {LinearHomingCommand} from '../src/homing/linear-command.ts';
import {GCodeMove} from '../src/gcode/move.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
const samples:number[]=[];
for(let run=0;run<6;run++){
 const t=await nativeCarriageFixture(run%2===1),carriage=t.port.carriageHoming!,ordinary={endstop:0,positiveDirection:false,speed:100,secondSpeed:50,retractSpeed:100,retractDistance:0,endstops:['other']};
 const command=new LinearHomingCommand(t.kinematics,new GCodeMove(t.port),t.port,[carriage.rails[0],ordinary,ordinary],10000);let hits=0;
 const timer=setInterval(()=>{
  if(t.port.status.phase!=='seek'){t.f.fw.setTriggerReason(2,8);t.f.fw.setTriggerReason(2,9);return;}
  const arms=t.f.fw.outputs.filter(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0);if(arms.length<=hits)return;
  const arm=arms[hits],clock=BigInt(Number(arm.parameters.clock));if(t.f.options.members[0].session.clock.sync.getClock(serialClock.now())<clock)return;
  const second=Number(arm.parameters.oid)===6,trigger=second?9:8;hits++;
  t.f.fw.setTriggerReason(1,trigger);t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:Number(clock)+Number(arm.parameters.rest_ticks)},second?6:7);t.f.fw.emit('trsync_state',{oid:trigger,can_trigger:0,trigger_reason:1,clock:Number(clock)});
 },1);
 try{const start=performance.now();await command.home([0],new AbortController().signal);const elapsed=performance.now()-start;assert.equal(hits,2);assert.deepEqual(t.port.carriageStatus!.homed,[true,true]);if(run)samples.push(elapsed);}finally{clearInterval(timer);await t.close();}
}
console.log(JSON.stringify({runtime:process.version,scope:'Two-carriage G28 with simulated immediate endstop hits and real host scheduling; excludes fixture startup; includes scheduled seek lead times, not physical travel',samplesMs:samples,medianMs:[...samples].sort((a,b)=>a-b)[2]},null,2));
