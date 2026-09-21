import {statfsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {databaseOracle} from '../test/helpers/database-oracle.ts';
const batchSize=Number(process.env.DATABASE_BATCH_SIZE??0);if(!Number.isSafeInteger(batchSize)||batchSize<0||batchSize>200)throw new Error('Invalid DATABASE_BATCH_SIZE');
const dir=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'database-bench-')),count=200,value={temperature:210.125,name:'中文',payload:'x'.repeat(256)},times:number[]=[],delays:number[]=[];
try{
 for(let run=0;run<9;run++){
  const owner=await DatabaseStore.open({path:join(dir,`node-${run}.sqlite`)}),loop=monitorEventLoopDelay({resolution:1});loop.enable();
  try{const begin=performance.now();if(batchSize){for(let i=0;i<count;i+=batchSize)await owner.insertBatch('ui',Object.fromEntries(Array.from({length:Math.min(batchSize,count-i)},(_,j)=>['job'+(i+j),{status:value}])));for(let i=0;i<count;i+=batchSize){const keys=Array.from({length:Math.min(batchSize,count-i)},(_,j)=>'job'+(i+j));assert.deepEqual(await owner.getBatch('ui',keys),Object.fromEntries(keys.map(key=>[key,{status:value}])));}}else{for(let i=0;i<count;i++)await owner.insert('ui',`job${i}.status`,value);for(let i=0;i<count;i++)assert.deepEqual(await owner.get('ui',`job${i}.status`),value);}const elapsed=performance.now()-begin;if(run>=2){times.push(elapsed);delays.push(loop.max/1e6);}}
  finally{loop.disable();await owner.close();}
 }
 const program=databaseOracle().slice(0,databaseOracle().indexOf('def main():'))+`
import os,asyncio
from threading import Thread
from queue import Queue
worker_methods=[n for n in provider.body if isinstance(n,ast.FunctionDef) and n.name in {'run','execute_db_function'}]
exec('from __future__ import annotations\\nclass Worker(Provider,Thread):\\n'+textwrap.indent(ast.unparse(ast.Module(body=worker_methods,type_ignores=[])),'    '))
async def bench():
 values=[]
 payload=json.loads(sys.stdin.read());value=payload['value'];batch_size=payload['batchSize']
 for run in range(9):
  path=os.path.join(sys.argv[1],'python-'+str(run)+'.sqlite')
  _,conn=create(path);conn.execute('PRAGMA journal_mode=WAL');conn.execute('PRAGMA synchronous=FULL');conn.close()
  owner=Worker();owner.server=Server();owner._namespaces=set();owner._db_path=path;owner.asyncio_loop=asyncio.get_running_loop();owner.command_queue=Queue();owner.start()
  try:
   start=time.perf_counter()
   if batch_size:
    for i in range(0,200,batch_size): await owner.execute_db_function(owner.insert_batch,'ui',{'job'+str(j):{'status':value} for j in range(i,min(i+batch_size,200))})
    for i in range(0,200,batch_size):
     keys=['job'+str(j) for j in range(i,min(i+batch_size,200))]
     assert await owner.execute_db_function(owner.get_batch,'ui',keys)=={key:{'status':value} for key in keys}
   else:
    for i in range(200): await owner.execute_db_function(owner.insert_item,'ui','job'+str(i)+'.status',value)
    for i in range(200): assert await owner.execute_db_function(owner.get_item,'ui','job'+str(i)+'.status')==value
   elapsed=(time.perf_counter()-start)*1000
   if run>=2: values.append(elapsed)
  finally:
   stopped=owner.asyncio_loop.create_future();owner.command_queue.put_nowait((stopped,None,tuple()));await stopped;owner.join()
 print(json.dumps(values))
asyncio.run(bench())
`;
 const result=spawnSync('/usr/bin/python3',['-c',program,dir],{input:JSON.stringify({value,batchSize}),encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(values.length/2)],p95Ms:values.at(-1)!};};
 console.log(JSON.stringify({node:process.version,filesystemMagic:statfsSync(dir).type,filesystem:statfsSync(dir).type===0x01021994?'tmpfs':statfsSync(dir).type===0xef53?'ext-family':'other',benchmarkRoot:process.env.DATABASE_BENCH_ROOT??tmpdir(),batchSize,writes:count,reads:count,nodeWorker:stats(times),pythonProviderThread:stats(JSON.parse(result.stdout)),nodeEventLoopMaxMs:Math.max(...delays),scope:'File-backed SQLite WAL + synchronous FULL on both sides; Node includes Worker round trips and bounded admission, Python uses original provider thread and Future dispatch; host filesystem only, not power-loss or target-board acceptance'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
