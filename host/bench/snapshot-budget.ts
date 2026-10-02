import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {createSealedPrintReader} from '../src/gcode/sealed-file.ts';
import {defaultPrintSnapshotBudget} from '../src/gcode/snapshot-budget.ts';
const directory=await mkdtemp(join(tmpdir(),'snapshot-budget-bench-')),path=join(directory,'file'),script=join(directory,'before.ts');
const text='G1 X1 Y2 E3 F12000\n'.repeat(100000),digest=createHash('sha256').update(text).digest('hex'),prepare:number[][]=[[],[]],consume:number[][]=[[],[]];
try{
 const source=execFileSync('git',['show','7efc3a7d:host/src/gcode/sealed-file.ts'],{encoding:'utf8'}).replace("'../../build/sealed-file.node'",JSON.stringify(new URL('../build/sealed-file.node',import.meta.url).pathname)).replace(/from '(\.[^']+)'/g,(_match,path:string)=>`from '${new URL(path,new URL('../src/gcode/sealed-file.ts',import.meta.url)).href}'`);
 await writeFile(script,source);const {createSealedPrintReader:before}=await import(pathToFileURL(script).href) as {createSealedPrintReader:typeof createSealedPrintReader};await writeFile(path,text);
 for(let run=0;run<13;run++)for(const variant of run%2?[1,0]:[0,1]){
  const file=await open(path,'r'),signal=new AbortController().signal;let snapshot:Awaited<ReturnType<typeof createSealedPrintReader>>|undefined;
  try{let start=performance.now();snapshot=await (variant?createSealedPrintReader:before)(file,digest,signal);const preparation=performance.now()-start;
   if(variant)assert.equal(defaultPrintSnapshotBudget.status.reservations,1);
   let lines=0;const hash=createHash('sha256');start=performance.now();while(true){const batch=await snapshot.reader.next(signal);if(!batch)break;lines+=batch.lines;hash.update(batch.script+'\n');snapshot.reader.commit(batch);}await snapshot.reader.close();const elapsed=performance.now()-start;
   assert.equal(lines,100000);assert.equal(hash.digest('hex'),digest);assert.equal(defaultPrintSnapshotBudget.status.reservations,0);if(run>=2){prepare[variant].push(preparation);consume[variant].push(elapsed);}
  }finally{await snapshot?.reader.close();await file.close();}
 }
 const stats=(a:number[])=>{a.sort((x,y)=>x-y);return {medianMs:a[5],p95Ms:a[10]};};
 console.log(JSON.stringify({node:process.version,baseline:'7efc3a7d',warmups:2,runs:11,lines:100000,bytes:Buffer.byteLength(text),variants:['sealedWithoutQuota','sealedWithQuota'],prepare:prepare.map(stats),consumeAndClose:consume.map(stats),budget:defaultPrintSnapshotBudget.status,scope:'Cached files, sealed copies and quota lifetime; no memory-pressure, swap or target-board guarantee'},null,2));
}finally{await rm(directory,{recursive:true,force:true});}
