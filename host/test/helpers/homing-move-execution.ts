import {homingEndstopSampling} from '../../src/homing/endstop-rate.ts';
import {recoveryFixture} from './homing-recovery.ts';
import {serialClock} from '../../src/protocol/serial-queue.ts';
import {homingToolheadPositions} from '../../src/homing/toolhead-position.ts';
import {StepHistory} from '../../src/motion/step-history.ts';
import type {HomingMoveOptions,ArmedHomingGroup} from '../../src/homing/move-execution.ts';
export async function nativeHomingFixture(count=1,independent=false,frequencies:readonly number[]=Array(count).fill(1e6)){
 const history=Array.from({length:count},()=>new StepHistory(0n,0n));
 let f!:Awaited<ReturnType<typeof recoveryFixture>>;
 f=await recoveryFixture(count,undefined,async outputs=>{for(const out of outputs){const i=Number(out.id.slice(1)),stepper=f.options.bindings[i].stepper;history[i].append(out,stepper.clockAt(stepper.generatedTime));}});
 try{
 const now=serialClock.now(),clocks=f.sessions.map(s=>s.clock.sync.getClock(now)),primary=Math.min(...clocks.map((c,i)=>Number(c)/frequencies[i]));
 const emitters=f.options.emitters.map((e,i)=>{const frequency=frequencies[i],timeOffset=primary-Number(clocks[i])/frequency;f.options.coordinator.calibrateClock([e.id],timeOffset,frequency);return {...e,settings:{...e.settings,timeOffset,frequency}};});
 const lead=.2,startTime=primary+lead,endTime=startTime+.3;
 f.options.bindings[0].queue.appendRaw(new Float64Array([startTime,0,.3,0,0,0,0,1,0,0,10,10,0]));await f.options.coordinator.advance(startTime);
 const groups:ArmedHomingGroup[]=[];
 const make=(indices:number[])=>{
  const starts=indices.map(i=>f.options.bindings[i].stepper.clockAt(startTime)),stepper=f.options.bindings[indices[0]].stepper;
  const sampling=homingEndstopSampling(f.options.endstop,stepper,8,startTime,[0,0,0],[3,0,0],10,indices.map(i=>({stepper:f.options.bindings[i].stepper,stepDistance:.01})));
  groups.push({members:indices.map(i=>f.options.members[i]),primary:0,endstop:f.options.endstop,sampling,startClocks:starts,expireTimeout:.25});
 };
 if(independent)for(let i=0;i<count;i++)make([i]);else make(Array.from({length:count},(_,i)=>i));
 const options:HomingMoveOptions={...f.options,emitters,groups,startTime,endTime,histories:history.map((h,member)=>({member,oid:1,history:h})),locate:readback=>({queues:[{id:'xyz',position:homingToolheadPositions({mode:'home',actuators:emitters.map((e,member)=>({id:e.id,member,oid:1,commanded:3,stepDistance:.01})),offsets:readback.offsets,reference:[3,0,0,0],calculate:p=>[p.get('s0')!,0,0]}).halt.slice(0,3) as [number,number,number]}],printTime:Math.max(...f.sessions.map((s,i)=>f.options.bindings[i].stepper.printTimeAtClock(s.clock.sync.getClock(serialClock.now()))))+1})};
 f.fs.forEach((fw,i)=>fw.setStepperPosition(1,23+i));
 const hit=(member:number,reason=1,at=.02)=>{
  const stepper=f.options.bindings[member].stepper,clock=stepper.clockAt(startTime+at),group=groups[independent?member:0];
  f.fs[member].setTriggerReason(reason,8);f.fs[member].setStepperPosition(1,Math.round(at*1000)+3+member);
  f.fs[member].setEndstopState({homing:0,pin_value:0,next_clock:Number(clock+group.sampling.restTicks)},7);
  f.fs[member].emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:reason,clock:Number(clock)});
 };
 return {f,options,history,lead,hit,async close(){await f.close();}};
 }catch(error){await f.close();throw error;}
}
