import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {initialLinearFixture} from '../test/helpers/initial-linear.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const f=await initialLinearFixture();try{
  const {port,kinematics}=f.initial.createLinearPort(f.reader,f.settings),plan=f.hardware.plan.heaters[0],runtime=f.hardware.analog[0].runtime,session=f.group.session(plan.sensor.mcu),raw=Math.round(plan.configuration.converter.adc(25)*plan.sensor.adc.maximumSum),next=session.clock.sync.getClock(serialClock.now())+292000n;
  f.firmware[1].emit('analog_in_state',{oid:plan.sensor.adc.oid,next_clock:Number(BigInt.asUintN(32,next)),values:Buffer.from([raw&255,raw>>8])});const deadline=performance.now()+1000;while(!runtime.status.received){assert(performance.now()<deadline);await delay(2);}
  kinematics.markHomed([0]);port.move([1,0,0,0],10);
  const used=process.cpuUsage(),start=performance.now();
  if(mode)await f.hardware.heaters.setTarget('extruder',200,f.signal);else{await port.drain(f.signal);await runtime.setTarget(200,f.signal);}
  const elapsed=performance.now()-start,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000);}
  assert.equal(runtime.status.target,200);assert.equal(port.status.pendingMoves,0);assert.equal(f.initial.generation.motion.bindings[0].history.status.lastPlannedPosition,80n);
  assert.equal(f.firmware[0].motion.filter(m=>m.name==='queue_step').reduce((n,m)=>n+Number(m.parameters.count),0),80);
  const end=f.initial.generation.source.status.sourceTime;for(const member of f.initial.generation.clockMembers)assert(member.session.clock.sync.getClock(serialClock.now())>=member.stepper.clockAt(end));
 }finally{await f.hardware.close();await f.close();}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats);
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,steps:80,variants:['explicitDrainAndTarget','managedRegistryTarget'],timing,cpu:usage,scope:'Native XYZE drain, every MCU clock confirmation, then heater target. Excludes connection/configuration and ADC setup. Simulated hardware, not physical heating/printing proof.'}));
assert(timing[1].medianMs<timing[0].medianMs*1.2+5);assert(timing[1].p95Ms<timing[0].p95Ms*1.2+10);assert(usage[1].medianMs<usage[0].medianMs*1.5+2);
