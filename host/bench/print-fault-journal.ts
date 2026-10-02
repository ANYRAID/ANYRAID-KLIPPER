import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {PrintController,type PrintDevice} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
const file=new URL('../src/operations/.print-baseline-'+randomUUID()+'.ts',import.meta.url),dir=await mkdtemp(join(tmpdir(),'fault-bench-'));
const samples:number[][]=[[],[]],faults:number[]=[],warmup=3,runs=11,jobs=100;
const device=():PrintDevice=>({async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){}});
const request=(requestId:string)=>({version:1 as const,requestId,fileId:'file',nozzle:200,bed:60});
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(values.length/2)],p95Ms:values.at(-1)!};};
try{
 await writeFile(file,execFileSync('git',['show','0b0db0a7:host/src/operations/print.ts']));
 const Baseline=(await import(file.href)).PrintController as typeof PrintController;
 for(let run=0;run<warmup+runs;run++)for(const mode of run%2?[1,0]:[0,1]){
  const controller=new (mode?PrintController:Baseline)(device(),{maxNozzle:300,maxBed:130});const begin=performance.now();
  for(let i=0;i<jobs;i++){await controller.start(request(String(i)));await controller.pause();await controller.resume();await controller.complete(String(i));controller.reset(String(i));}
  const elapsed=performance.now()-begin;if(run>=warmup)samples[mode].push(elapsed);await controller.retire();
 }
 for(let run=0;run<warmup+runs;run++){
  const journal=await PrintJournal.open({path:join(dir,run+'.db'),deviceId:'printer'}),controller=new PrintController(device(),{maxNozzle:300,maxBed:130},{},{journal});
  try{await controller.start(request('fault'));const begin=performance.now();await controller.fault(new Error('benchmark fault'));const elapsed=performance.now()-begin;assert.equal((await journal.get('fault'))?.state,'failed');if(run>=warmup)faults.push(elapsed);}finally{await controller.retire();await journal.close();}
 }
 const baseline=stats(samples[0]),current=stats(samples[1]),durableFault=stats(faults);console.log(JSON.stringify({node:process.version,baselineCommit:'0b0db0a7',warmup,runs,jobs,baseline,current,durableFault,scope:'Alternating 100 start/pause/resume/complete/reset cycles without journal; separately real SQLite fault persistence including immediate mock stop. Excludes journal startup. Local filesystem and simulated device; not physical stopping time or print throughput.'},null,2));
 assert(current.medianMs<=baseline.medianMs*1.2+2);assert(current.p95Ms<=baseline.p95Ms*1.3+3);assert(durableFault.p95Ms<1000);
}finally{await rm(file,{force:true});await rm(dir,{recursive:true,force:true});}
