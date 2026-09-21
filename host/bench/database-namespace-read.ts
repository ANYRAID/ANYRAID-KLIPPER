import {statfsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {databaseOracle} from '../test/helpers/database-oracle.ts';
const dir=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'db-namespace-read-')),value={temperature:210.125,payload:'x'.repeat(256)},keys=Array.from({length:200},(_,i)=>'job'+i).sort(),values=keys.map(()=>value),items=keys.map(key=>[key,value]),records=Object.fromEntries(items),samples:number[]=[],delays:number[]=[];
try{
 for(let round=0;round<9;round++){const store=await DatabaseStore.open({path:join(dir,`node-${round}.db`)}),loop=monitorEventLoopDelay({resolution:1});loop.enable();try{await store.insertBatch('ui',records);const start=performance.now();for(let i=0;i<50;i++){assert.deepEqual(await store.namespaceKeys('ui'),keys);assert.deepEqual(await store.namespaceValues('ui'),values);assert.deepEqual(await store.namespaceItems('ui'),items);assert.equal(await store.namespaceContains('ui','job100.temperature'),true);}const elapsed=performance.now()-start;if(round>=2){samples.push(elapsed);delays.push(loop.max/1e6);}}finally{loop.disable();await store.close();}}
 const base=databaseOracle().slice(0,databaseOracle().indexOf('def main():')),program=base+String.raw`
import os,asyncio
from threading import Thread
from queue import Queue
methods=[n for n in provider.body if isinstance(n,ast.FunctionDef) and n.name in {'run','execute_db_function'}]
exec('from __future__ import annotations\nclass Worker(Provider,Thread):\n'+textwrap.indent(ast.unparse(ast.Module(body=methods,type_ignores=[])),'    '))
async def bench():
 samples=[];value=json.loads(sys.stdin.read());keys=sorted('job'+str(i) for i in range(200));values=[value for key in keys];items=[(key,value) for key in keys]
 for run in range(9):
  path=os.path.join(sys.argv[1],'python-'+str(run)+'.db');initial,conn=create(path);conn.execute('PRAGMA journal_mode=WAL');conn.execute('PRAGMA synchronous=FULL');initial.insert_batch(conn,'ui',dict(items));conn.close()
  owner=Worker();owner.server=Server();owner._namespaces={'ui'};owner._db_path=path;owner.asyncio_loop=asyncio.get_running_loop();owner.command_queue=Queue();owner.start()
  try:
   start=time.perf_counter()
   for i in range(50):
    assert await owner.execute_db_function(owner.get_namespace_keys,'ui')==keys
    assert await owner.execute_db_function(owner.get_namespace_values,'ui')==values
    assert [tuple(row) for row in await owner.execute_db_function(owner.get_namespace_items,'ui')]==items
    assert await owner.execute_db_function(owner.namespace_contains,'ui','job100.temperature')
   elapsed=(time.perf_counter()-start)*1000
   if run>=2: samples.append(elapsed)
  finally:
   stopped=owner.asyncio_loop.create_future();owner.command_queue.put_nowait((stopped,None,tuple()));await stopped;owner.join()
 print(json.dumps(samples))
asyncio.run(bench())
`;
 const result=spawnSync('/usr/bin/python3',['-c',program,dir],{input:JSON.stringify(value),encoding:'utf8'});assert.equal(result.status,0,result.stderr);const stats=(samples:number[])=>{const sorted=samples.toSorted((a,b)=>a-b);return {medianMs:sorted[3],p95Ms:sorted[6]};};console.log(JSON.stringify({node:process.version,filesystemMagic:statfsSync(dir).type,benchmarkRoot:process.env.DATABASE_BENCH_ROOT??tmpdir(),records:200,cycles:50,nodeWorker:stats(samples),pythonProviderThread:stats(JSON.parse(result.stdout)),eventLoopMaxMs:Math.max(...delays),scope:'Each cycle keys/values/items/contains with result verification; setup excluded, bounded Node Worker versus original Python provider thread; host file-backed SQLite, not target-board acceptance'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
