import assert from 'node:assert/strict';
import {initialLinearFixture} from '../test/helpers/initial-linear.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
// The status read itself owns no timer or output. Transport/printing overhead
// is checked separately against the same compiled product in mixed acceptance.
const f=await initialLinearFixture();
try{
 const g=f.initial.generation,{port,kinematics}=f.initial.createLinearPort(f.reader,f.configuredSettings),before={source:g.source.status,coordinator:g.coordinator.status,timelines:g.clockMembers.map(m=>m.timeline?.status),outputs:f.firmware.map(m=>m.outputs.length)};
 const wall:number[][]=[[],[]],cpu:number[][]=[[],[]],iterations=50000;let checksum=0;
 for(let run=0;run<14;run++)for(const clock of run%2?[true,false]:[false,true]){
  const used=process.cpuUsage(),start=performance.now(),eventtime=serialClock.now();
  for(let i=0;i<iterations;i++){
   const k=kinematics.status,status={homed_axes:k.homedAxes,position:port.homingPosition(),extruder:'extruder',axis_minimum:[...k.axisMinimum,0],axis_maximum:[...k.axisMaximum,0],...port.velocityStatus};
   checksum+=status.position[0]+status.max_velocity;
   if(clock){const estimate=port.estimatedPrintTime(eventtime+i/iterations);assert.equal(typeof estimate,'number');assert(Number.isFinite(estimate));checksum+=estimate!;}
  }
  const elapsed=(performance.now()-start)*1000/iterations,usage=process.cpuUsage(used);if(run>=3){wall[Number(clock)].push(elapsed);cpu[Number(clock)].push((usage.user+usage.system)/iterations);}
 }
 const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianUs:v[5],p95Us:v[10]};},timing=wall.map(stats),usage=cpu.map(stats),maximumAddedUs=5;
 assert.deepEqual({source:g.source.status,coordinator:g.coordinator.status,timelines:g.clockMembers.map(m=>m.timeline?.status),outputs:f.firmware.map(m=>m.outputs.length)},before);
 console.log(JSON.stringify({node:process.version,warmup:3,samples:11,iterations,variants:['existingToolheadFields','fieldsWithEstimatedPrintTime'],timing,cpu:usage,maximumAddedUs,checksum,scope:'Actual configured two-MCU native port. Alternating construction of existing toolhead fields versus those fields plus MCU clock read; CPU, time and no-motion/no-calibration checks. Excludes network, physical devices and target board.'}));
 assert(checksum>0);assert(timing[1].medianUs-timing[0].medianUs<maximumAddedUs);assert(timing[1].p95Us-timing[0].p95Us<maximumAddedUs);assert(usage[1].medianUs-usage[0].medianUs<maximumAddedUs);
}finally{await f.hardware.close();await f.close();}
