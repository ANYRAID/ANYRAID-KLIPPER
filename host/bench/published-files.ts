import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm,statfs} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {createSealedPrintReader} from '../src/gcode/sealed-file.ts';
const directory=await mkdtemp(join(fileURLToPath(new URL('../build/',import.meta.url)),'published-bench-')),path=join(directory,'source'),store=await PublishedPrintFiles.open(join(directory,'store'));
const publish:number[]=[],acquire:number[][]=[[],[]],read:number[][]=[[],[]],body='G1 X1 Y2 E3 F12000\n'.repeat(100000);
try{
 for(let run=0;run<13;run++){
  const data=`; run ${run}\n`+body,digest=createHash('sha256').update(data).digest('hex');await writeFile(path,data);const source=await open(path,'r'),signal=new AbortController().signal;
  try{
   let begin=performance.now();const record=await store.publish('job'+run,'part.gcode',source,signal),published=performance.now()-begin;assert.equal(record.sha256,digest);if(run>=2)publish.push(published);
   for(const variant of run%2?[1,0]:[0,1]){
    begin=performance.now();const reader=variant?await store.acquire('job'+run,signal):(await createSealedPrintReader(source,digest,signal)).reader,prepared=performance.now()-begin;
    try{const hash=createHash('sha256');let lines=0;begin=performance.now();while(true){const batch=await reader.next(signal);if(!batch)break;hash.update(batch.script+'\n');lines+=batch.lines;reader.commit(batch);}const elapsed=performance.now()-begin;assert.equal(hash.digest('hex'),digest);assert.equal(lines,100001);if(run>=2){acquire[variant].push(prepared);read[variant].push(elapsed);}}finally{await reader.close();}
   }
  }finally{await source.close();}
 }
 const stats=(a:number[])=>{a.sort((x,y)=>x-y);return {medianMs:a[5],p95Ms:a[10]};};
 console.log(JSON.stringify({node:process.version,filesystemType:(await statfs(directory)).type,warmups:2,runs:11,lines:100001,bytesApproximately:Buffer.byteLength(body),publishWithFsync:stats(publish),variants:['directSealedSnapshot','publishedReceiptAndSnapshot'],acquire:acquire.map(stats),read:read.map(stats),scope:'Fresh digest per publication on workspace filesystem, requested file/directory fsync and cached reads; not power-loss or board validation'},null,2));
}finally{await store.close();await rm(directory,{recursive:true,force:true});}
