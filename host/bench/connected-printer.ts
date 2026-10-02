import assert from 'node:assert/strict';
import {configuredPrinterFixture} from '../test/helpers/configured-printer.ts';
import {connectConfiguredPrinter,startClockedPrinter} from '../src/runtime/configured-printer.ts';
const limits={wallMedianRatio:1.1,wallP95Ratio:1.2,wallSlackMs:10,cpuMedianRatio:1.5,cpuSlackMs:5};
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const f=await configuredPrinterFixture(false,false);let printer:Awaited<ReturnType<typeof startClockedPrinter>>|undefined;
 try{
  const used=process.cpuUsage(),start=performance.now();
  if(mode)printer=await connectConfiguredPrinter(f.reader,f.connections,'mcu',f.layout,f.options,f.signal);
  else{await f.group.start(f.signal);printer=await startClockedPrinter(f.reader,f.group,'mcu',f.layout,f.options,f.signal);}
  const elapsed=performance.now()-start,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000);}
  assert.equal(printer.hardware.status.state,'ready');assert.equal(printer.linear.kinematics.status.homedAxes,'');assert.equal(f.firmware[0].motion.length,0);
 }finally{await printer?.close();await f.close();}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats);
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,variants:['explicitConnection','ownedConnection'],limits,timing,cpu:usage,scope:'Native MCU emulator connections, clock warmup, hardware configuration and print assembly. Excludes fixture construction, close and physical printing.'}));
assert(timing[1].medianMs<timing[0].medianMs*limits.wallMedianRatio+limits.wallSlackMs);
assert(timing[1].p95Ms<timing[0].p95Ms*limits.wallP95Ratio+limits.wallSlackMs);
assert(usage[1].medianMs<usage[0].medianMs*limits.cpuMedianRatio+limits.cpuSlackMs);
