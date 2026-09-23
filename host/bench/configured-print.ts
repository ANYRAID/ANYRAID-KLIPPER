import assert from 'node:assert/strict';
import {initialLinearFixture} from '../test/helpers/initial-linear.ts';
import {NativeLinearGCode} from '../src/runtime/native-linear-gcode.ts';
import {createNativeLinearPrint} from '../src/operations/native-linear-print.ts';
import type {ConfiguredPrintOptions} from '../src/runtime/initial-motion.ts';
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const f=await initialLinearFixture(false,true);let owner:Awaited<ReturnType<typeof createNativeLinearPrint>>|undefined;
 try{
  const linear=f.initial.createLinearPort(f.reader,f.settings),options:ConfiguredPrintOptions={output(){},motorCompletion:'hold',startupHoming:{mode:'require_homed',axes:[0,1,2]},parking:{parkXY:[0,0],retract:0,lift:0,travelSpeed:10,liftSpeed:5,retractSpeed:5},lifecycle:{prepare:async()=>{},start:async()=>{},finishOutputs:async()=>{},stopOutputs:async()=>{}},open:async()=>{throw new Error('Unexpected benchmark file open');}};
  const used=process.cpuUsage(),start=performance.now();
  owner=mode?await linear.createPrint(options):await createNativeLinearPrint({...options,gcode:new NativeLinearGCode(linear.port,linear.kinematics,linear.rails,options.output),port:linear.port,heaters:f.hardware.heaters,mapping:{nozzle:'extruder',bed:'heater_bed'}});
  const elapsed=performance.now()-start,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000);}
  assert(owner.gcode.usesPort(linear.port));assert.equal(linear.kinematics.status.homedAxes,'');assert.equal(f.firmware[0].motion.length,0);assert.equal(f.hardware.heaters.status.available_heaters.length,2);
 }finally{await owner?.close();await f.hardware.close();await f.close();}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats);
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,variants:['explicitAssembly','configuredOwner'],timing,cpu:usage,scope:'Same configured native XYZE and two actual ADC heater runtimes. Measures dispatch/print assembly, excludes startup, printing and close. No hardware proof.'}));
assert(timing[1].medianMs<timing[0].medianMs*1.5+.5);assert(timing[1].p95Ms<timing[0].p95Ms*2+1);assert(usage[1].medianMs<usage[0].medianMs*1.5+1);
