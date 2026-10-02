import assert from 'node:assert/strict';
import {mkdtemp,open,writeFile,readFile,rm,statfs} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {planNamespaceMove} from '../src/storage/namespace-move.ts';
const baselinePath=process.env.PUBLISHED_DIRECTORY_BASELINE;if(!baselinePath)throw new Error('Expected fixed pre-change PUBLISHED_DIRECTORY_BASELINE');
const Baseline=(await import(pathToFileURL(baselinePath).href)).PublishedPrintFiles as typeof PublishedPrintFiles;
const directory=await mkdtemp(join(process.cwd(),'.published-dir-move-bench-')),signal=new AbortController().signal,stores:PublishedPrintFiles[]=[];
const summarize=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.floor(sorted.length*.95)],maxMs:sorted.at(-1)};};
try{
 const path=join(directory,'source');await writeFile(path,'G1 X1.000001\n');const source=await open(path,'r');
 try{for(const [index,Store] of [Baseline,PublishedPrintFiles].entries()){const store=await Store.open(join(directory,'files-'+index));stores.push(store);await store.mutateDirectory('parts',false,signal);for(let i=0;i<1024;i++)await store.publish(String(i).padStart(4,'0'),'part.gcode',source,signal,i<128?'parts/'+i+'.gcode':i+'.gcode');}}finally{await source.close();}
 const samples:number[][]=[[],[]];for(let run=0;run<14;run++)for(const index of run%2?[1,0]:[0,1]){const start=performance.now();for(let n=0;n<50;n++)assert.equal((await stores[index].catalog(signal)).length,1024);if(run>=3)samples[index].push((performance.now()-start)/50);}
 const catalogs=samples.map(summarize);assert(catalogs[1].p95Ms<50);
 const store=stores[1],loop=monitorEventLoopDelay({resolution:1}),times:number[]=[],concurrentCatalog:number[]=[];loop.enable();await new Promise(resolve=>setTimeout(resolve,10));
 for(let i=0;i<20;i++){const begin=performance.now();let finished=false;const mutation=(async()=>{await store.moveDirectory(await store.prepareDirectoryMove(i%2?'renamed':'parts',i%2?'parts':'renamed',signal),signal);})().finally(()=>{finished=true;});while(!finished){const readBegin=performance.now();assert.equal((await store.catalog(signal)).length,1024);concurrentCatalog.push(performance.now()-readBegin);await new Promise(resolve=>setTimeout(resolve,5));}await mutation;times.push(performance.now()-begin);}
 await new Promise(resolve=>setTimeout(resolve,10));loop.disable();assert.equal(store.filename('0000'),'parts/0.gcode');assert.equal(store.filename('0128'),'128.gcode');assert.equal(await readFile(join(directory,'files-1',(await store.inspect('0000')).sha256+'.gcode'),'utf8'),'G1 X1.000001\n');
 assert(summarize(concurrentCatalog).p95Ms<50,'Concurrent cached catalog retains original 50 ms tail budget');
 const eventLoop={p99Ms:loop.percentile(99)/1e6,maxMs:loop.max/1e6};assert(eventLoop.p99Ms<50);assert(eventLoop.maxMs<100);
 const files=Array.from({length:10000},(_,i)=>({file:{version:1 as const,id:'f'+i,sha256:'a'.repeat(64),size:1,name:i+'.gcode',path:'parts/'+i+'.gcode'},modified:1})),planner:number[]=[];
 for(let i=0;i<14;i++){const begin=performance.now();assert.equal(planNamespaceMove('parts','renamed',files,new Map([['parts',1]])).changed.length,10000);if(i>=3)planner.push(performance.now()-begin);}
 console.log(JSON.stringify({node:process.version,baseline:baselinePath,filesystemType:'0x'+(await statfs(directory,{bigint:true})).type.toString(16),files:1024,movedFilesPerOperation:128,operations:times.length,catalog:{baseline:catalogs[0],candidate:catalogs[1],medianRatio:catalogs[1].medianMs/catalogs[0].medianMs},directoryMove:summarize(times),concurrentCatalog:{reads:concurrentCatalog.length,...summarize(concurrentCatalog)},eventLoop,planner10000:summarize(planner),scope:'Workspace filesystem durable directory operations and alternating cached catalog baseline; original 50 ms catalog P95 and 50/100 ms loop budgets retained. 10,000-file planner is a capacity experiment, not an actual 10,000-file transaction or target-board/print-duration acceptance.'}));
}finally{await Promise.all(stores.map(store=>store.close()));await rm(directory,{recursive:true,force:true});}
