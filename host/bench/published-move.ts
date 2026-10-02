import assert from 'node:assert/strict';
import {mkdtemp,open,writeFile,readFile,rm,statfs} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
const baselinePath=process.env.PUBLISHED_MOVE_BASELINE;if(!baselinePath)throw new Error('Expected fixed pre-change store module in PUBLISHED_MOVE_BASELINE');
const Baseline=(await import(pathToFileURL(baselinePath).href)).PublishedPrintFiles as typeof PublishedPrintFiles;
const directory=await mkdtemp(join(process.cwd(),'.published-move-bench-')),signal=new AbortController().signal,stores:PublishedPrintFiles[]=[];
const summarize=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.floor(sorted.length*.95)],maxMs:sorted.at(-1)};};
try{
 const sourcePath=join(directory,'source');await writeFile(sourcePath,'G1 X1.000001\n');const source=await open(sourcePath,'r');
 try{for(const [index,Store] of [Baseline,PublishedPrintFiles].entries()){const store=await Store.open(join(directory,'files-'+index));stores.push(store);for(let i=0;i<1024;i++)await store.publish(String(i).padStart(4,'0'),'part.gcode',source,signal);}}finally{await source.close();}
 const samples:number[][]=[[],[]];
 for(let run=0;run<14;run++)for(const index of run%2?[1,0]:[0,1]){const start=performance.now();for(let n=0;n<50;n++)assert.equal((await stores[index].catalog(signal)).length,1024);if(run>=3)samples[index].push((performance.now()-start)/50);}
 const catalog=samples.map(summarize);assert(catalog[1].p95Ms<50,'Retain existing catalog tail budget');
 const move:number[]=[],loop=monitorEventLoopDelay({resolution:1}),store=stores[1],before=await store.inspect('0000');loop.enable();await new Promise(resolve=>setTimeout(resolve,10));
 for(let i=0;i<200;i++){const start=performance.now(),plan=await store.prepareFileMove(i%2?'renamed.gcode':'0000.gcode',i%2?'0000.gcode':'renamed.gcode',signal);await store.moveFile(plan,signal);move.push(performance.now()-start);}
 await new Promise(resolve=>setTimeout(resolve,10));loop.disable();assert.equal(store.filename('0000'),'0000.gcode');assert.equal((await store.inspect('0000')).sha256,before.sha256);assert.equal(await readFile(join(directory,'files-1',before.sha256+'.gcode'),'utf8'),'G1 X1.000001\n');
 const eventLoop={p99Ms:loop.percentile(99)/1e6,maxMs:loop.max/1e6};assert(eventLoop.p99Ms<50);assert(eventLoop.maxMs<100);
 console.log(JSON.stringify({node:process.version,filesystemType:'0x'+(await statfs(directory,{bigint:true})).type.toString(16),files:1024,baseline:baselinePath,catalog:{baseline:catalog[0],candidate:catalog[1],medianRatio:catalog[1].medianMs/catalog[0].medianMs},moves:move.length,move:summarize(move),eventLoop,scope:'Alternating fixed pre-change versus candidate cached catalogs; 200 durable single-receipt moves on the workspace filesystem. Existing 50 ms catalog and 50/100 ms loop budgets retained. No old move implementation, target board or actual print duration comparison.'}));
}finally{await Promise.all(stores.map(store=>store.close()));await rm(directory,{recursive:true,force:true});}
