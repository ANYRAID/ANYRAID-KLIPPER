import {statfsSync} from 'node:fs';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {databaseBenchmarkReference} from '../test/helpers/database-reference.ts';
const dir=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'database-backup-bench-')),path=join(dir,'source.sqlite'),times:number[]=[],delays:number[]=[],store=await DatabaseStore.open({path,backupDirectory:dir});
try{
 await store.insertBatch('ui',Object.fromEntries(Array.from({length:1000},(_,i)=>['key'+i,{value:i,payload:'x'.repeat(1024)}])));
 for(let run=0;run<9;run++){
  const loop=monitorEventLoopDelay({resolution:1});loop.enable();const start=performance.now();await store.backup('node.db');const elapsed=performance.now()-start;loop.disable();if(run>=2){times.push(elapsed);delays.push(loop.max/1e6);}
  const check=new DatabaseSync(join(dir,'node.db'),{readOnly:true});try{assert.equal(check.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');assert.equal(Number(check.prepare('SELECT count(*) AS n FROM namespace_store').get()!.n),1000);}finally{check.close();}
 }
 const historical=databaseBenchmarkReference('database-backup',JSON.stringify({records:1000,payloadBytes:1024}));
 const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(values.length/2)],p95Ms:values.at(-1)!};};console.log(JSON.stringify({node:process.version,filesystemMagic:statfsSync(dir).type,filesystem:statfsSync(dir).type===0x01021994?'tmpfs':statfsSync(dir).type===0xef53?'ext-family':'other',benchmarkRoot:process.env.DATABASE_BENCH_ROOT??tmpdir(),records:1000,snapshotBytes:(await stat(join(dir,'node.db'))).size,nodeBackup:stats(times),pythonBackupThread:historical?stats([...historical.samplesMs]):null,nodeEventLoopMaxMs:Math.max(...delays),historicalPythonReference:historical,nodeSamplesMs:[...times],scope:'Historical Python timings are frozen and may use another filesystem/environment; current Node measurements and original assertions remain. Same WAL source and original Python provider thread. Node also stages, fsyncs and atomically publishes replacement; filesystem and process checks, not hardware power-loss acceptance'},null,2));
}finally{await store.close();await rm(dir,{recursive:true,force:true});}
