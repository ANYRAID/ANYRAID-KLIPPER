import {statfsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {databaseBenchmarkReference} from '../test/helpers/database-reference.ts';
const namespaceSync=process.env.DATABASE_SYNC_NAMESPACE==='1';
const namespaceLifecycle=process.env.DATABASE_NAMESPACE_LIFECYCLE==='1';
const batchSize=Number(process.env.DATABASE_BATCH_SIZE??0);if(!Number.isSafeInteger(batchSize)||batchSize<0||batchSize>200)throw new Error('Invalid DATABASE_BATCH_SIZE');
const dir=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'database-bench-')),count=200,value={temperature:210.125,name:'中文',payload:'x'.repeat(256)},times:number[]=[],delays:number[]=[];
try{
 for(let run=0;run<9;run++){
  const owner=await DatabaseStore.open({path:join(dir,`node-${run}.sqlite`)}),loop=monitorEventLoopDelay({resolution:1});loop.enable();
  try{if(namespaceSync)await owner.registerNamespace('ui');const begin=performance.now();if(namespaceSync){for(let cycle=0;cycle<20;cycle++){const records=Object.fromEntries(Array.from({length:count},(_,i)=>['job'+i,{status:value,cycle}]));await owner.syncNamespace('ui',records);assert.deepEqual(await owner.get('ui'),records);}}else if(namespaceLifecycle){for(let cycle=0;cycle<20;cycle++){await owner.insertBatch('ui',Object.fromEntries(Array.from({length:count},(_,i)=>['job'+i,{status:value}])));assert.equal(await owner.namespaceLength('ui'),count);await owner.clearNamespace('ui');assert.deepEqual(await owner.get('ui'),{});await owner.dropEmptyNamespace('ui');assert.equal(await owner.namespaceLength('ui'),0);}}else if(batchSize){for(let i=0;i<count;i+=batchSize)await owner.insertBatch('ui',Object.fromEntries(Array.from({length:Math.min(batchSize,count-i)},(_,j)=>['job'+(i+j),{status:value}])));for(let i=0;i<count;i+=batchSize){const keys=Array.from({length:Math.min(batchSize,count-i)},(_,j)=>'job'+(i+j));assert.deepEqual(await owner.getBatch('ui',keys),Object.fromEntries(keys.map(key=>[key,{status:value}])));}}else{for(let i=0;i<count;i++)await owner.insert('ui',`job${i}.status`,value);for(let i=0;i<count;i++)assert.deepEqual(await owner.get('ui',`job${i}.status`),value);}const elapsed=performance.now()-begin;if(run>=2){times.push(elapsed);delays.push(loop.max/1e6);}}
  finally{loop.disable();await owner.close();}
 }
 const historical=databaseBenchmarkReference('database',JSON.stringify({value,batchSize,namespaceLifecycle,namespaceSync}));
 const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(values.length/2)],p95Ms:values.at(-1)!};};
 console.log(JSON.stringify({node:process.version,filesystemMagic:statfsSync(dir).type,filesystem:statfsSync(dir).type===0x01021994?'tmpfs':statfsSync(dir).type===0xef53?'ext-family':'other',benchmarkRoot:process.env.DATABASE_BENCH_ROOT??tmpdir(),batchSize,namespaceLifecycle,namespaceSync,...namespaceLifecycle||namespaceSync?{cycles:20,recordsPerCycle:count}:{writes:count,reads:count},nodeWorker:stats(times),pythonProviderThread:historical?stats([...historical.samplesMs]):null,nodeEventLoopMaxMs:Math.max(...delays),historicalPythonReference:historical,nodeSamplesMs:[...times],scope:'Historical Python timings are frozen and may use another filesystem/environment; current Node measurements and original assertions remain. File-backed SQLite WAL + synchronous FULL on both sides; Node includes Worker round trips and bounded admission, Python uses original provider thread and Future dispatch; host filesystem only, not power-loss or target-board acceptance'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
