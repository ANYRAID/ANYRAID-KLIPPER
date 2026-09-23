import assert from 'node:assert/strict';
import {planLinearPrinter} from '../src/config/linear-printer.ts';
import {readLinearMotionConfiguration} from '../src/config/linear-motion.ts';
import {configuredPrinterFixture} from '../test/helpers/configured-printer.ts';
const f=await configuredPrinterFixture(false,false),wall:number[][]=[[],[]],cpu:number[][]=[[],[]],iterations=1000,limits={medianSlackMs:.1,p95SlackMs:.2};
try{
 for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
  const used=process.cpuUsage(),start=performance.now();
  for(let i=0;i<iterations;i++)if(mode){const p=planLinearPrinter(f.reader,{mcus:['mcu','aux'],enableLeadTime:.001,fanMinimumScheduleTime:.001});assert.deepEqual(p.motion.map(m=>m.mode),['x','y','z','extruder']);}else readLinearMotionConfiguration(f.reader);
  const elapsed=(performance.now()-start)/iterations,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000/iterations);}
 }
 const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats);
 console.log(JSON.stringify({node:process.version,warmup:3,samples:11,iterations,variants:['existingLinearConfig','automaticHardwarePlan'],limits,timing,cpu:usage,scope:'Configuration planning only, timed after unstarted fixture setup; no new device IO or physical printing.'}));
 assert(timing[1].medianMs<timing[0].medianMs+limits.medianSlackMs);assert(timing[1].p95Ms<timing[0].p95Ms+limits.p95SlackMs);assert(usage[1].medianMs<usage[0].medianMs+limits.medianSlackMs);
}finally{await f.close();}
