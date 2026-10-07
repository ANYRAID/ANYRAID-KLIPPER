import {statfsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {databaseBenchmarkReference} from '../test/helpers/database-reference.ts';
const changing=process.env.DATABASE_ENUMERATION_CHANGING==='1',maxReadCacheBytes=Number(process.env.DATABASE_READ_CACHE_BYTES??8*1024*1024);
const dir=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'db-namespace-read-')),value={temperature:210.125,payload:'x'.repeat(256)},keys=Array.from({length:200},(_,i)=>'job'+i).sort(),values=keys.map(()=>value),items=keys.map(key=>[key,value]),records=Object.fromEntries(items),samples:number[]=[],delays:number[]=[];
try{
 for(let round=0;round<9;round++){const store=await DatabaseStore.open({path:join(dir,`node-${round}.db`),maxReadCacheBytes}),loop=monitorEventLoopDelay({resolution:1});loop.enable();try{await store.insertBatch('ui',records);const start=performance.now();for(let i=0;i<50;i++){if(changing){const current={...value,epoch:i};await store.insert('ui',keys[0],current);values[0]=current;items[0]=[keys[0],current];}assert.deepEqual(await store.namespaceKeys('ui'),keys);assert.deepEqual(await store.namespaceValues('ui'),values);assert.deepEqual(await store.namespaceItems('ui'),items);assert.equal(await store.namespaceContains('ui','job100.temperature'),true);}const elapsed=performance.now()-start;if(round>=2){samples.push(elapsed);delays.push(loop.max/1e6);}}finally{loop.disable();await store.close();}}
 const historical=databaseBenchmarkReference('database-namespace-read',JSON.stringify({value,changing}));
 const stats=(samples:number[])=>{const sorted=samples.toSorted((a,b)=>a-b);return {medianMs:sorted[3],p95Ms:sorted[6]};};console.log(JSON.stringify({node:process.version,filesystemMagic:statfsSync(dir).type,benchmarkRoot:process.env.DATABASE_BENCH_ROOT??tmpdir(),records:200,cycles:50,changing,maxReadCacheBytes,nodeWorker:stats(samples),pythonProviderThread:historical?stats([...historical.samplesMs]):null,eventLoopMaxMs:Math.max(...delays),historicalPythonReference:historical,nodeSamplesMs:[...samples],scope:'Historical Python timings are frozen and may use another filesystem/environment; current Node measurements and original assertions remain. Each cycle keys/values/items/contains with result verification; setup excluded, bounded Node Worker versus original Python provider thread; host file-backed SQLite, not target-board acceptance'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
