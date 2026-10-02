import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm,statfs,stat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
const directory=await mkdtemp(join(fileURLToPath(new URL('../build/',import.meta.url)),'recovery-bench-'));
const baseline='4d921e7e',body='G1 X1 Y2 E3 F12000\n'.repeat(100000);
const publish:number[][]=[[],[]],acquire:number[][]=[[],[]],read:number[][]=[[],[]],startup:number[]=[];
const stores:PublishedPrintFiles[]=[];
const summarize=(a:number[])=>{const sorted=[...a].sort((x,y)=>x-y);return {medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.ceil(sorted.length*.95)-1]};};
try{
 const source=execFileSync('git',['show',`${baseline}:host/src/storage/published-files.ts`],{encoding:'utf8'}).replace(/from '(\.[^']+)'/g,(_match,path:string)=>`from '${new URL(path,new URL('../src/storage/published-files.ts',import.meta.url)).href}'`);
 const script=join(directory,'before.ts');await writeFile(script,source);
 const {PublishedPrintFiles:Before}=await import(pathToFileURL(script).href) as {PublishedPrintFiles:typeof PublishedPrintFiles};
 stores.push(await Before.open(join(directory,'before')),await PublishedPrintFiles.open(join(directory,'current')));
 for(let run=0;run<13;run++){
  const data=`; run ${run}\n`+body,digest=createHash('sha256').update(data).digest('hex'),path=join(directory,'source');
  await writeFile(path,data);const file=await open(path,'r'),signal=new AbortController().signal;
  try{for(const variant of run%2?[1,0]:[0,1]){
   const store=stores[variant];let begin=performance.now();
   const record=await store.publish('job'+run,'part.gcode',file,signal),published=performance.now()-begin;
   assert.equal(record.sha256,digest);begin=performance.now();const reader=await store.acquire(record.id,signal),prepared=performance.now()-begin;
   try{
    let lines=0;const hash=createHash('sha256');begin=performance.now();
    while(true){const batch=await reader.next(signal);if(!batch)break;hash.update(batch.script+'\n');lines+=batch.lines;reader.commit(batch);}
    await reader.close();const consumed=performance.now()-begin;
    assert.equal(lines,100001);assert.equal(hash.digest('hex'),digest);
    if(run>=2){publish[variant].push(published);acquire[variant].push(prepared);read[variant].push(consumed);}
   }finally{await reader.close();}
  }}finally{await file.close();}
 }
 assert.equal(stores[1].status.reservedBytes,0);
 const currentRoot=join(directory,'current');let actualBytes=0;
 for(const name of await readdir(currentRoot))actualBytes+=(await stat(join(currentRoot,name))).size;
 assert.equal(stores[1].status.storedBytes,actualBytes);
 const record=await stores[1].inspect('job0');await stores[1].close();
 // Exercise startup metadata recovery at the default scale with shared content.
 for(let id=13;id<1000;id++)await writeFile(join(currentRoot,`job${id}.json`),JSON.stringify({...record,id:`job${id}`}));
 actualBytes=0;for(const name of await readdir(currentRoot))actualBytes+=(await stat(join(currentRoot,name))).size;
 for(let run=0;run<13;run++){
  const begin=performance.now(),store=await PublishedPrintFiles.open(currentRoot),elapsed=performance.now()-begin;
  try{assert.equal(store.status.publishedFiles,1000);assert.equal(store.status.storedBytes,actualBytes);if(run>=2)startup.push(elapsed);}finally{await store.close();}
 }
 console.log(JSON.stringify({node:process.version,baseline,filesystemType:(await statfs(directory)).type,warmups:2,runs:11,lines:100001,bytesApproximately:Buffer.byteLength(body),variants:['beforeOwnershipAndQuota','withOwnershipAndQuota'],publishWithFsync:publish.map(summarize),acquire:acquire.map(summarize),readAndClose:read.map(summarize),startup:{receipts:1000,distinctBlobs:13,bytes:actualBytes,...summarize(startup)},scope:'Alternating cached-file comparisons on workspace filesystem; fresh digest per publication; startup validates metadata, acquire checks digest. Not power-loss, physical disk block quota or target-board timing acceptance.'},null,2));
}finally{for(const store of stores)await store.close();await rm(directory,{recursive:true,force:true});}
