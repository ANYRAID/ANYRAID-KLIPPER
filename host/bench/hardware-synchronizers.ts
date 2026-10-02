import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileConfiguredHardware} from '../src/config/hardware.ts';
import {hardwareFixture,hardwareReader,hardwareLayout} from '../test/helpers/configured-hardware.ts';
import {ClockSync} from '../src/timing/clock-sync.ts';
import {captureGroupPrintClocks} from '../src/timing/group-print-clocks.ts';
function fixture(){const f=hardwareFixture();for(const [i,s] of [...f.sessions.values()].entries())Object.assign(s,{clock:{sync:new ClockSync(1e6,BigInt(1+i*2)*1000000n,10)}});return {...f,clocks:captureGroupPrintClocks(f.group,'mcu',10)};}
const directory=mkdtempSync(join(tmpdir(),'shared-hardware-bench-')),wall:number[][]=[[],[]],cpu:number[][]=[[],[]],iterations=100;
try{
 const source=execFileSync('git',['show','10323e74:host/src/config/hardware.ts'],{encoding:'utf8'}),file=join(directory,'hardware.ts');
 writeFileSync(file,source.replace(/from '([^']+)'/g,(_match,spec:string)=>`from '${new URL(spec,new URL('../src/config/hardware.ts',import.meta.url)).href}'`));
 const previous=(await import(pathToFileURL(file).href)).compileConfiguredHardware as typeof compileConfiguredHardware,reader=hardwareReader(),f=fixture(),clocks=f.clocks;
 const before=previous(reader,f.group,clocks,hardwareLayout),after=compileConfiguredHardware(reader,f.group,clocks,hardwareLayout);assert.deepEqual(after.configurations.map(c=>c.plan),before.configurations.map(c=>c.plan));assert.notEqual(after.configurations[1].synchronizer,clocks.get('aux')!.synchronizer);
 for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
  const start=performance.now(),used=process.cpuUsage();for(let i=0;i<iterations;i++){const plan=(mode?compileConfiguredHardware:previous)(reader,f.group,clocks,hardwareLayout);assert.equal(plan.steppers[0].stepDistance,.0125);}
  const elapsed=(performance.now()-start)/iterations,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000/iterations);}
 }
 const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats),limits={medianRatio:1.5,medianSlackMs:.2,p95Ratio:2,p95SlackMs:.25};
 console.log(JSON.stringify({node:process.version,baselineRevision:'10323e74',warmup:3,samples:11,iterations,variants:['sharedClocks','ownedSynchronizers'],timing,cpu:usage,limits,scope:'Two-MCU hardware planning, allocation and identical command plans; capture excluded, no IO or physical printing.'}));
 assert(timing[1].medianMs<timing[0].medianMs*limits.medianRatio+limits.medianSlackMs);assert(timing[1].p95Ms<timing[0].p95Ms*limits.p95Ratio+limits.p95SlackMs);assert(usage[1].medianMs<usage[0].medianMs*limits.medianRatio+limits.medianSlackMs);
}finally{rmSync(directory,{recursive:true,force:true});}
