import {mkdtemp,rm} from 'node:fs/promises';
import {statfsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {databaseBenchmarkReference} from '../test/helpers/database-reference.ts';
const dir=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'table-bench-')),samples:number[]=[],delays:number[]=[];
try{
 for(let run=0;run<7;run++){const path=join(dir,`node-${run}.db`);let store=await DatabaseStore.open({path});const loop=monitorEventLoopDelay({resolution:1});loop.enable();try{
  let start=performance.now();for(let i=0;i<50;i++){const name='jobs'+i;await store.registerTable({name,prototype:`${name} (id INTEGER PRIMARY KEY, value REAL)`,version:1,migrations:{'0':[`INSERT INTO ${name} VALUES(1,2.675)`]}});}let elapsed=performance.now()-start;await store.close();store=await DatabaseStore.open({path});
  start=performance.now();for(let i=0;i<50;i++){const name='jobs'+i;await store.registerTable({name,prototype:`${name} (id INTEGER PRIMARY KEY, value REAL, label TEXT DEFAULT 'ready')`,version:2,migrations:{'1':[`ALTER TABLE ${name} ADD COLUMN label TEXT DEFAULT 'ready'`]}});}elapsed+=performance.now()-start;
  const db=new DatabaseSync(path,{readOnly:true});try{for(let i=0;i<50;i++){assert.deepEqual({...db.prepare(`SELECT * FROM jobs${i}`).get()},{id:1,value:2.675,label:'ready'});assert.equal(db.prepare('SELECT version FROM table_registry WHERE name=?').get('jobs'+i)!.version,2);}}finally{db.close();}if(run>=2){samples.push(elapsed);delays.push(loop.max/1e6);}
 }finally{loop.disable();await store.close();}}
 const historical=databaseBenchmarkReference('database-table',JSON.stringify({tables:50}));
 const stats=(x:number[])=>{const a=x.toSorted((x,y)=>x-y);return {medianMs:a[2],p95Ms:a.at(-1)};};console.log(JSON.stringify({node:process.version,filesystemMagic:statfsSync(dir).type,tables:50,nodeWorker:stats(samples),pythonProvider:historical?stats([...historical.samplesMs]):null,eventLoopMaxMs:Math.max(...delays),historicalPythonReference:historical,nodeSamplesMs:[...samples],scope:'Historical Python timings are frozen and may use another filesystem/environment; current Node measurements and original assertions remain. 50 creates plus 50 upgrades, WAL/FULL; open/close and row assertions excluded. Node uses one atomic transaction and worker round trips, Python original registration commits creation/migration/metadata separately. Not equal durability work or hardware timing.'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
