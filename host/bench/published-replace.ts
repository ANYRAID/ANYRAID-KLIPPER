import assert from 'node:assert/strict';
import {mkdtemp,open,writeFile,rm,readdir,stat,statfs} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
const baselinePath=process.env.PUBLISHED_REPLACE_BASELINE;if(!baselinePath)throw new Error('Expected immutable pre-overwrite Node store in PUBLISHED_REPLACE_BASELINE');
const Baseline=(await import(pathToFileURL(baselinePath).href)).PublishedPrintFiles as typeof PublishedPrintFiles;
const root=await mkdtemp(join(process.cwd(),'.published-replace-bench-')),signal=new AbortController().signal,stores:PublishedPrintFiles[]=[];
const summarize=(values:number[])=>{const s=[...values].sort((a,b)=>a-b);return {medianMs:s[Math.floor(s.length/2)],p95Ms:s[Math.floor(s.length*.95)],maxMs:s.at(-1)};};
let source:Awaited<ReturnType<typeof open>>|undefined,replacement:Awaited<ReturnType<typeof open>>|undefined,reader:Awaited<ReturnType<PublishedPrintFiles['acquire']>>|undefined;
try{
 await writeFile(join(root,'source'),'G1 X1.000001\n'.repeat(4096));await writeFile(join(root,'replacement'),'G1 X2.000002\n'.repeat(4096));source=await open(join(root,'source'),'r');replacement=await open(join(root,'replacement'),'r');
 for(const [index,Store] of [Baseline,PublishedPrintFiles].entries()){const store=await Store.open(join(root,'files-'+index),{maxPublishedFiles:2048});stores.push(store);for(let i=0;i<1024;i++){const id=String(i).padStart(4,'0');await store.publish(id,id+'.gcode',source,signal,id+'.gcode');}}
 const samples:number[][]=[[],[]];for(let run=0;run<14;run++)for(const index of run%2?[1,0]:[0,1]){const begin=performance.now();for(let n=0;n<50;n++)assert.equal((await stores[index].catalog(signal)).length,1024);if(run>=3)samples[index].push((performance.now()-begin)/50);}
 const catalogs=samples.map(summarize);assert(catalogs[1].p95Ms<50,'Preserve cached catalog P95 budget');
 const store=stores[1],loop=monitorEventLoopDelay({resolution:1}),uploads:number[]=[],moves:number[]=[],reads:number[]=[];let events=0;
 store.observeChanges(()=>events++);reader=await store.acquire('0001',signal);loop.enable();await new Promise(resolve=>setTimeout(resolve,10));
 const measure=async(operation:()=>Promise<unknown>)=>{const begin=performance.now();let finished=false;const work=operation().finally(()=>{finished=true;});while(!finished){const start=performance.now(),catalog=await store.catalog(signal);assert(catalog.length===1023||catalog.length===1024);assert.equal(new Set(catalog.map(e=>e.file.path)).size,catalog.length,'Coherent published paths');reads.push(performance.now()-start);await new Promise(resolve=>setTimeout(resolve,5));}await work;return performance.now()-begin;};
 for(let i=0;i<25;i++){
  uploads.push(await measure(async()=>store.replaceUpload(await store.prepareUploadReplacement('new-'+i,'0001.gcode','0001.gcode',signal),replacement!,signal)));assert.equal(await store.resolvePath('0001.gcode',signal),'new-'+i);
  moves.push(await measure(async()=>store.moveFile(await store.prepareFileMove('0000.gcode','0001.gcode',signal),signal)));assert.equal(await store.resolvePath('0001.gcode',signal),'0000');await assert.rejects(store.inspect('new-'+i),{code:'ENOENT'});
  await store.moveFile(await store.prepareFileMove('0001.gcode','0000.gcode',signal),signal);await store.publish('0001','0001.gcode',source,signal,'0001.gcode');
 }
 await new Promise(resolve=>setTimeout(resolve,10));loop.disable();assert.equal(events,100);assert.equal((await store.catalog(signal)).length,1024);assert.equal(store.status.reservedBytes,0);
 const batch=(await reader.next(signal))!;assert(batch.script.includes('G1 X1.000001'));await reader.close();reader=undefined;
 const charged=(await Promise.all((await readdir(join(root,'files-1'))).map(async name=>(await stat(join(root,'files-1',name))).size))).reduce((a,b)=>a+b,0);assert.equal(store.status.storedBytes,charged);
 const eventLoop={p99Ms:loop.percentile(99)/1e6,maxMs:loop.max/1e6};assert(summarize(reads).p95Ms<50);assert(eventLoop.p99Ms<50);assert(eventLoop.maxMs<100);
 await store.close();stores[1]=await PublishedPrintFiles.open(join(root,'files-1'),{maxPublishedFiles:2048});assert.equal((await stores[1].catalog(signal)).length,1024);assert.equal(stores[1].status.storedBytes,charged);
 console.log(JSON.stringify({node:process.version,baseline:baselinePath,filesystemType:'0x'+(await statfs(root,{bigint:true})).type.toString(16),files:1024,fileBytes:53248,catalog:{baseline:catalogs[0],candidate:catalogs[1],medianRatio:catalogs[1].medianMs/catalogs[0].medianMs},uploadOverwrites:{operations:25,...summarize(uploads)},moveOverwrites:{operations:25,...summarize(moves)},concurrentCatalog:{reads:reads.length,...summarize(reads)},eventLoop,events,chargedBytes:charged,reopened:true,scope:'Workspace filesystem local Node baseline and overwrite load; original catalog and event-loop gates retained, coherent cache/old reader and accounting checked. Not independent compiled concurrent printing, CPython/target-board timing, physical power loss, full clients or complete M2b acceptance.'}));
}finally{await reader?.close();await Promise.all(stores.map(store=>store.close()));await source?.close();await replacement?.close();await rm(root,{recursive:true,force:true});}
