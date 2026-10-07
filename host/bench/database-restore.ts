import {statfsSync} from 'node:fs';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {databaseBenchmarkReference} from '../test/helpers/database-reference.ts';
const root=process.env.DATABASE_BENCH_ROOT??tmpdir(),dir=await mkdtemp(join(root,'database-restore-bench-')),snapshot=join(dir,'saved.db'),times:number[]=[],delays:number[]=[];
try{
 const template=await DatabaseStore.open({path:join(dir,'template.sqlite'),backupDirectory:dir});try{await template.insertBatch('ui',Object.fromEntries(Array.from({length:1000},(_,i)=>['key'+i,{value:i,payload:'x'.repeat(1024)}])));await template.backup('saved.db');}finally{await template.close();}
 for(let run=0;run<9;run++){
  const path=join(dir,`node-${run}.sqlite`),store=await DatabaseStore.open({path,backupDirectory:dir});
  try{await store.insert('ui','changed',run);const loop=monitorEventLoopDelay({resolution:1});loop.enable();const start=performance.now();const info=await store.restore('saved.db') as {restored_tables:string[];restored_namespaces:string[]};const elapsed=performance.now()-start;loop.disable();if(run>=2){times.push(elapsed);delays.push(loop.max/1e6);}assert.deepEqual(info.restored_namespaces,['ui']);assert.equal(store.status.restoreState,'restored');}finally{await store.close();}
  const check=new DatabaseSync(path,{readOnly:true});try{assert.equal(check.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');assert.equal(Number(check.prepare('SELECT count(*) AS n FROM namespace_store').get()!.n),1000);}finally{check.close();}
 }
 const historical=databaseBenchmarkReference('database-restore',JSON.stringify({records:1000,payloadBytes:1024}));
 const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(values.length/2)],p95Ms:values.at(-1)!};};const type=statfsSync(dir).type;
 console.log(JSON.stringify({node:process.version,benchmarkRoot:root,filesystemMagic:type,filesystem:type===0x01021994?'tmpfs':type===0xef53?'ext-family':'other',records:1000,snapshotBytes:(await stat(snapshot)).size,nodeRestore:stats(times),pythonRestoreThread:historical?stats([...historical.samplesMs]):null,nodeEventLoopMaxMs:Math.max(...delays),historicalPythonReference:historical,nodeSamplesMs:[...times],scope:'Historical Python timings are frozen and may use another filesystem/environment; current Node measurements and original assertions remain. Same snapshot, actual worker/thread restore. Node additionally checks integrity/schema/size and fences old operations. Excludes service restart latency and hardware power-loss acceptance'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
