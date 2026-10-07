import {statfsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {databaseBenchmarkReference} from '../test/helpers/database-reference.ts';
const dir=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'db-registration-')),samples:number[]=[],delays:number[]=[];
try{
 for(let round=0;round<9;round++){const store=await DatabaseStore.open({path:join(dir,`node-${round}.db`)}),loop=monitorEventLoopDelay({resolution:1});loop.enable();try{const start=performance.now();for(let i=0;i<100;i++)await store.registerLocalNamespace(`component${i}`,{forbidden:i%2===0});for(let i=0;i<100;i++)await store.unregisterLocalNamespace(`component${i}`);const elapsed=performance.now()-start;assert.deepEqual(await store.get('database','protected_namespaces'),['moonraker']);assert.deepEqual(await store.get('database','forbidden_namespaces'),['database']);if(round>=2){samples.push(elapsed);delays.push(loop.max/1e6);}}finally{loop.disable();await store.close();}}
 const historical=databaseBenchmarkReference('database-registration',JSON.stringify({registrations:100,unregistrations:100}));
 const stats=(samples:number[])=>{const sorted=samples.toSorted((a,b)=>a-b);return {medianMs:sorted[3],p95Ms:sorted[6]};};
 console.log(JSON.stringify({node:process.version,filesystemMagic:statfsSync(dir).type,benchmarkRoot:process.env.DATABASE_BENCH_ROOT??tmpdir(),registrations:100,unregistrations:100,nodeWorker:stats(samples),pythonSynchronousInitialization:historical?stats([...historical.samplesMs]):null,eventLoopMaxMs:Math.max(...delays),historicalPythonReference:historical,nodeSamplesMs:[...samples],scope:'Historical Python timings are frozen and may use another filesystem/environment; current Node measurements and original assertions remain. WAL/FULL; Node includes Worker dispatch and wrapper construction, pinned Python methods use synchronous provider initialization with stub wrapper; not equivalent runtime-thread scheduling or hardware acceptance'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
