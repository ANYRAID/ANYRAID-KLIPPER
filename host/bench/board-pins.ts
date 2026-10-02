import assert from 'node:assert/strict';
import {compileConfiguredHardware} from '../src/config/hardware.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {hardwareFixture,hardwareReader,hardwareLayout,hardwareClocks} from '../test/helpers/configured-hardware.ts';
const manual=hardwareReader(),configured=new ConfigurationReader(new ConfigurationSource('/board.cfg',{...manual.source.original,board_pins:{aliases:'STEP=PA0, POWER=<5V>'}},[]),null),clocks=hardwareClocks(),wall:number[][]=[[],[]],cpu:number[][]=[[],[]],iterations=100,limits={medianRatio:1.5,medianSlackMs:.2,p95Ratio:2,p95SlackMs:.25};
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const start=performance.now(),used=process.cpuUsage();
 for(let i=0;i<iterations;i++){
  const f=hardwareFixture(),plan=compileConfiguredHardware(mode?configured:manual,f.group,clocks,mode?{...hardwareLayout,boards:[]}:hardwareLayout);
  assert.deepEqual(plan.configurations.map(c=>c.plan.oidCount),[4,5]);assert.equal(plan.steppers[0].stepDistance,.0125);
 }
 const elapsed=(performance.now()-start)/iterations,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000/iterations);}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats);
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,iterations,variants:['manualBoardMap','configuredBoardPins'],limits,timing,cpu:usage,scope:'Full two-MCU hardware planning with fresh dictionaries; no MCU IO, native motion execution or physical printing.'}));
assert(timing[1].medianMs<timing[0].medianMs*limits.medianRatio+limits.medianSlackMs);assert(timing[1].p95Ms<timing[0].p95Ms*limits.p95Ratio+limits.p95SlackMs);assert(usage[1].medianMs<usage[0].medianMs*limits.medianRatio+limits.medianSlackMs);
