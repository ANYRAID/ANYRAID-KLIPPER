import assert from 'node:assert/strict';
import {nativeLinearFixture} from '../test/helpers/native-linear-port.ts';
const signal=()=>new AbortController().signal,times:number[]=[],cpu:number[]=[];
for(let run=0;run<14;run++){
 const t=await nativeLinearFixture(0,()=>false,true,undefined,true);
 try{
  t.kinematics.markHomed([0]);t.port.move([51,0,0,2],10);await t.port.drain(signal());const packets=t.f.fw.motion.length,begin=performance.now(),used=process.cpuUsage();await t.port.releaseMotors(signal());const elapsed=performance.now()-begin,usage=process.cpuUsage(used);
  const changes=t.f.fw.outputs.filter(m=>m.name==='queue_digital_out');assert.deepEqual(changes.map(m=>m.parameters.on_ticks),[0,1]);assert(t.generation.members[0].session.clock.sync.lastClock>BigInt(Number(changes[1].parameters.clock))+100000n);assert.equal(t.f.fw.motion.length,packets);assert.equal(t.kinematics.status.homedAxes,'');assert.equal(t.port.status.failed,false);assert.equal(t.f.stops,0);
  await t.port.releaseMotors(signal());assert.equal(t.f.fw.outputs.filter(m=>m.name==='queue_digital_out').length,2);
  if(run>=3){times.push(elapsed);cpu.push((usage.user+usage.system)/1000);}
 }finally{await t.close();}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=stats(times),usage=stats(cpu);
console.log(JSON.stringify({node:process.version,samples:11,timing,cpu:usage,requiredGuardMs:200,scope:'Real native motion completed before release timing; GPIO ACK and sampled MCU off-plus-guard barrier, serial firmware emulator, no hardware acceptance.'}));assert(timing.medianMs>=190&&timing.medianMs<500,'Motor release exceeded its 200 ms guard plus sampling budget');assert(usage.medianMs<15,'Motor release consumed excessive CPU while waiting for MCU time');
