import {statfsSync} from 'node:fs';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {databaseOracle} from '../test/helpers/database-oracle.ts';
const root=process.env.DATABASE_BENCH_ROOT??tmpdir(),dir=await mkdtemp(join(root,'database-restore-bench-')),snapshot=join(dir,'saved.db'),times:number[]=[],delays:number[]=[];
try{
 const template=await DatabaseStore.open({path:join(dir,'template.sqlite'),backupDirectory:dir});try{await template.insertBatch('ui',Object.fromEntries(Array.from({length:1000},(_,i)=>['key'+i,{value:i,payload:'x'.repeat(1024)}])));await template.backup('saved.db');}finally{await template.close();}
 for(let run=0;run<9;run++){
  const path=join(dir,`node-${run}.sqlite`),store=await DatabaseStore.open({path,backupDirectory:dir});
  try{await store.insert('ui','changed',run);const loop=monitorEventLoopDelay({resolution:1});loop.enable();const start=performance.now();const info=await store.restore('saved.db') as {restored_tables:string[];restored_namespaces:string[]};const elapsed=performance.now()-start;loop.disable();if(run>=2){times.push(elapsed);delays.push(loop.max/1e6);}assert.deepEqual(info.restored_namespaces,['ui']);assert.equal(store.status.restoreState,'restored');}finally{await store.close();}
  const check=new DatabaseSync(path,{readOnly:true});try{assert.equal(check.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');assert.equal(Number(check.prepare('SELECT count(*) AS n FROM namespace_store').get()!.n),1000);}finally{check.close();}
 }
 const code=databaseOracle().slice(0,databaseOracle().indexOf('def main():'))+`
import asyncio,os
from threading import Thread
from queue import Queue
methods=[n for n in provider.body if isinstance(n,ast.FunctionDef) and n.name in {'run','execute_db_function'}]
exec('from __future__ import annotations\\nclass Worker(Provider,Thread):\\n'+textwrap.indent(ast.unparse(ast.Module(body=methods,type_ignores=[])),'    '))
async def bench():
 values=[]
 for run in range(9):
  path=os.path.join(sys.argv[1],'python-'+str(run)+'.sqlite');initial,conn=create(path);conn.execute('CREATE TABLE table_registry (name TEXT NOT NULL PRIMARY KEY,prototype TEXT NOT NULL,version INT)');conn.execute('PRAGMA journal_mode=WAL');conn.execute('PRAGMA synchronous=FULL');initial.insert_item(conn,'ui','changed',run);conn.close()
  owner=Worker();owner.server=Server();owner.restored=False;owner._tables={'namespace_store','table_registry'};owner._namespaces={'ui'};owner._db_path=pathlib.Path(path);owner.asyncio_loop=asyncio.get_running_loop();owner.command_queue=Queue();owner.start()
  try:
   start=time.perf_counter();info=await owner.execute_db_function(owner.restore_database,pathlib.Path(sys.argv[2]));elapsed=(time.perf_counter()-start)*1000
   assert info['restored_namespaces']==['ui']
   if run>=2:values.append(elapsed)
  finally:
   stopped=owner.asyncio_loop.create_future();owner.command_queue.put_nowait((stopped,None,tuple()));await stopped;owner.join()
  check=sqlite3.connect(path);assert check.execute('PRAGMA integrity_check').fetchone()[0]=='ok';assert check.execute('SELECT count(*) FROM namespace_store').fetchone()[0]==1000;check.close()
 print(json.dumps(values))
asyncio.run(bench())
`;
 const result=spawnSync('/usr/bin/python3',['-c',code,dir,snapshot],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(values.length/2)],p95Ms:values.at(-1)!};};const type=statfsSync(dir).type;
 console.log(JSON.stringify({node:process.version,benchmarkRoot:root,filesystemMagic:type,filesystem:type===0x01021994?'tmpfs':type===0xef53?'ext-family':'other',records:1000,snapshotBytes:(await stat(snapshot)).size,nodeRestore:stats(times),pythonRestoreThread:stats(JSON.parse(result.stdout)),nodeEventLoopMaxMs:Math.max(...delays),scope:'Same snapshot, actual worker/thread restore. Node additionally checks integrity/schema/size and fences old operations. Excludes service restart latency and hardware power-loss acceptance'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
