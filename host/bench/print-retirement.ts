import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PrintController,type PrintDevice} from '../src/operations/print.ts';
const directory=mkdtempSync(join(tmpdir(),'retirement-bench-')),wall:number[][]=[[],[]],cpu:number[][]=[[],[]],jobs=1000;
try{
 const source=execFileSync('git',['show','9cd2c1c8:host/src/operations/print.ts'],{encoding:'utf8'}),file=join(directory,'print.ts');
 writeFileSync(file,source.replace(/from '([^']+)'/g,(_match,spec:string)=>`from '${new URL(spec,new URL('../src/operations/print.ts',import.meta.url)).href}'`));
 const Previous=(await import(pathToFileURL(file).href)).PrintController as typeof PrintController;
 for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
  let effects=0;const effect=async()=>{effects++;},device:PrintDevice={prepare:effect,start:effect,pause:effect,resume:effect,finish:effect,stop:effect};
  const used=process.cpuUsage(),start=performance.now();
  for(let i=0;i<jobs;i++){
   const controller=new (mode?PrintController:Previous)(device,{maxNozzle:300,maxBed:130});await controller.start({version:1,requestId:'job',fileId:'file',nozzle:0,bed:0});await controller.pause();await controller.resume();
   if(mode)await controller.retire();else await controller.cancel();assert.equal(controller.state,'cancelled');assert.equal(controller.pendingDeviceActions,0);
  }
  const elapsed=performance.now()-start,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed/jobs);cpu[mode].push((usage.user+usage.system)/1000/jobs);}assert.equal(effects,jobs*5);
 }
 const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMsPerJob:a[5],p95MsPerJob:a[10]};},timing=wall.map(stats),usage=cpu.map(stats),limits={ratio:1.25,slackMsPerJob:.01};
 console.log(JSON.stringify({node:process.version,baselineRevision:'9cd2c1c8',warmup:3,samples:11,jobs,variants:['startPauseResumeCancel','startPauseResumeRetire'],timing,cpu:usage,limits,scope:'Product operation admission and completion with immediate mock acknowledgements. No native IO, journal or physical motion.'}));
 assert(timing[1].medianMsPerJob<timing[0].medianMsPerJob*limits.ratio+limits.slackMsPerJob);assert(usage[1].medianMsPerJob<usage[0].medianMsPerJob*limits.ratio+limits.slackMsPerJob);
}finally{rmSync(directory,{recursive:true,force:true});}
