import assert from 'node:assert/strict';
import {configuredPrinterFixture} from '../test/helpers/configured-printer.ts';
import {startConfiguredPrinter} from '../src/runtime/configured-printer.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {initializeConfiguredMotion} from '../src/runtime/initial-motion.ts';
// Gates are deliberately defined before sampling: startup composition overhead,
// not physical printer throughput or a serial discovery benchmark.
const limits={medianRatio:1.5,medianSlackMs:5,p95Ratio:2,p95SlackMs:5};
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const f=await configuredPrinterFixture();let hardware:Awaited<ReturnType<typeof startConfiguredHardware>>|undefined;
 try{
  const used=process.cpuUsage(),start=performance.now();
  let linear,print;
  if(mode){const owner=await startConfiguredPrinter(f.reader,f.group,f.clocks,f.layout,f.options,f.signal);hardware=owner.hardware;linear=owner.linear;print=owner.print;}
  else{hardware=await startConfiguredHardware(f.reader,f.group,f.clocks,f.layout,f.options.hardware,f.signal);const initial=await initializeConfiguredMotion(hardware,f.options.motion,f.signal);linear=initial.createLinearPort(f.reader,f.options.linear);print=await linear.createPrint(f.options.print);}
  const elapsed=performance.now()-start,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000);}
  assert.equal(hardware.status.state,'ready');assert(print.gcode.usesPort(linear.port));assert.equal(linear.kinematics.status.homedAxes,'');assert.equal(f.firmware[0].motion.length,0);
 }finally{await hardware?.close();await f.close();}
}
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[5],p95Ms:values[10]};},timing=wall.map(stats),usage=cpu.map(stats);
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,variants:['explicitStartup','unifiedStartup'],limits,timing,cpu:usage,scope:'Connected native MCU emulators, configuration through print assembly; excludes connection, close and physical printing.'}));
assert(timing[1].medianMs<timing[0].medianMs*limits.medianRatio+limits.medianSlackMs);
assert(timing[1].p95Ms<timing[0].p95Ms*limits.p95Ratio+limits.p95SlackMs);
assert(usage[1].medianMs<usage[0].medianMs*limits.medianRatio+limits.medianSlackMs);
