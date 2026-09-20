import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm,statfs} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
const directory=await mkdtemp(join(fileURLToPath(new URL('../build/',import.meta.url)),'delete-bench-'));
const warmups=5,runs=51,total=warmups+runs;
const baseline='c0ab719d',body='G1 X1 Y2 E3 F12000\n'.repeat(100000);
const publish:number[][]=[[],[]],acquire:number[][]=[[],[]],read:number[][]=[[],[]],parallel:number[][]=[[],[]],remove:number[][]=[[],[]];
const stores:PublishedPrintFiles[]=[];
const stats=(a:number[])=>{const sorted=[...a].sort((x,y)=>x-y);return {medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.ceil(sorted.length*.95)-1]};};
try{
 const source=execFileSync('git',['show',`${baseline}:host/src/storage/published-files.ts`],{encoding:'utf8'}).replace("'../../build/sealed-file.node'",JSON.stringify(fileURLToPath(new URL('../build/sealed-file.node',import.meta.url)))).replace(/from '(\.[^']+)'/g,(_match,path:string)=>`from '${new URL(path,new URL('../src/storage/published-files.ts',import.meta.url)).href}'`);
 const script=join(directory,'before.ts');await writeFile(script,source);
 const {PublishedPrintFiles:Before}=await import(pathToFileURL(script).href) as {PublishedPrintFiles:typeof PublishedPrintFiles};
 stores.push(await Before.open(join(directory,'before')),await PublishedPrintFiles.open(join(directory,'current')));
 for(let run=0;run<total;run++){
  const data=`; run ${run}\n`+body,digest=createHash('sha256').update(data).digest('hex'),path=join(directory,'source');
  await writeFile(path,data);const file=await open(path,'r'),signal=new AbortController().signal;
  try{
   for(const variant of run%2?[1,0]:[0,1]){
    const store=stores[variant];let begin=performance.now();
    const record=await store.publish('job'+run,'part.gcode',file,signal),published=performance.now()-begin;
    assert.equal(record.sha256,digest);begin=performance.now();const reader=await store.acquire(record.id,signal),prepared=performance.now()-begin;
    try{
     let lines=0;const hash=createHash('sha256');begin=performance.now();
     while(true){const batch=await reader.next(signal);if(!batch)break;hash.update(batch.script+'\n');lines+=batch.lines;reader.commit(batch);}
     await reader.close();const consumed=performance.now()-begin;
     assert.equal(lines,100001);assert.equal(hash.digest('hex'),digest);
     if(run>=warmups){publish[variant].push(published);acquire[variant].push(prepared);read[variant].push(consumed);}
    }finally{await reader.close();}
   }
   await stores[1].publish('alias'+run,'copy.gcode',file,signal);
   for(const [index,id] of ['job'+run,'alias'+run].entries()){
    const begin=performance.now();await stores[1].remove(id,signal);if(run>=warmups)remove[index].push(performance.now()-begin);
   }
   assert.equal(stores[1].status.storedBytes,0);
  }finally{await file.close();}
 }
 for(let run=0;run<total;run++){
  const files:Awaited<ReturnType<typeof open>>[]=[];
  try{
   for(let i=0;i<4;i++){const path=join(directory,'parallel'+i);await writeFile(path,`; ${run}:${i}\n`+body);files.push(await open(path,'r'));}
   for(const variant of run%2?[1,0]:[0,1]){
    const begin=performance.now();const records=await Promise.all(files.map((file,i)=>stores[variant].publish(`p${run}_${i}`,'part.gcode',file,new AbortController().signal)));
    const elapsed=performance.now()-begin;if(run>=warmups)parallel[variant].push(elapsed);
    assert.equal(new Set(records.map(record=>record.sha256)).size,4);
   }
   for(let i=0;i<4;i++)await stores[1].remove(`p${run}_${i}`,new AbortController().signal);
   assert.equal(stores[1].status.storedBytes,0);assert.equal(stores[1].status.reservedBytes,0);
  }finally{for(const file of files)await file.close();}
 }
 console.log(JSON.stringify({node:process.version,baseline,filesystemType:(await statfs(directory)).type,warmups,runs,lines:100001,bytesApproximately:Buffer.byteLength(body),variants:['withoutDeletionBarrier','withDeletionBarrier'],publishWithFsync:publish.map(stats),acquire:acquire.map(stats),readAndClose:read.map(stats),fourConcurrentPublications:parallel.map(stats),deleteWithFsync:{sharedContent:stats(remove[0]),lastReference:stats(remove[1])},scope:'Alternating cached workspace-file measurements; per-read digest and line checks, shared-content and last-reference deletion, four concurrent distinct uploads. No board or power-loss acceptance.'},null,2));
}finally{for(const store of stores)await store.close();await rm(directory,{recursive:true,force:true});}
