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
const dir=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'database-backup-bench-')),path=join(dir,'source.sqlite'),times:number[]=[],delays:number[]=[],store=await DatabaseStore.open({path,backupDirectory:dir});
try{
 await store.insertBatch('ui',Object.fromEntries(Array.from({length:1000},(_,i)=>['key'+i,{value:i,payload:'x'.repeat(1024)}])));
 for(let run=0;run<9;run++){
  const loop=monitorEventLoopDelay({resolution:1});loop.enable();const start=performance.now();await store.backup('node.db');const elapsed=performance.now()-start;loop.disable();if(run>=2){times.push(elapsed);delays.push(loop.max/1e6);}
  const check=new DatabaseSync(join(dir,'node.db'),{readOnly:true});try{assert.equal(check.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');assert.equal(Number(check.prepare('SELECT count(*) AS n FROM namespace_store').get()!.n),1000);}finally{check.close();}
 }
 const code=databaseOracle().slice(0,databaseOracle().indexOf('def main():'))+`
import asyncio
from threading import Thread
from queue import Queue
methods=[n for n in provider.body if isinstance(n,ast.FunctionDef) and n.name in {'run','execute_db_function'}]
exec('from __future__ import annotations\\nclass Worker(Provider,Thread):\\n'+textwrap.indent(ast.unparse(ast.Module(body=methods,type_ignores=[])),'    '))
async def bench():
 owner=Worker();owner.server=Server();owner.restored=False;owner._namespaces={'ui'};owner._db_path=sys.argv[1];owner.asyncio_loop=asyncio.get_running_loop();owner.command_queue=Queue();owner.start();values=[]
 try:
  for run in range(9):
   start=time.perf_counter();await owner.execute_db_function(owner.backup_database,pathlib.Path(sys.argv[2]));elapsed=(time.perf_counter()-start)*1000
   if run>=2:values.append(elapsed)
   check=sqlite3.connect(sys.argv[2]);assert check.execute('PRAGMA integrity_check').fetchone()[0]=='ok';assert check.execute('SELECT count(*) FROM namespace_store').fetchone()[0]==1000;check.close()
 finally:
  stopped=owner.asyncio_loop.create_future();owner.command_queue.put_nowait((stopped,None,tuple()));await stopped;owner.join()
 print(json.dumps(values))
asyncio.run(bench())
`;
 const result=spawnSync('/usr/bin/python3',['-c',code,path,join(dir,'python.db')],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(values.length/2)],p95Ms:values.at(-1)!};};console.log(JSON.stringify({node:process.version,filesystemMagic:statfsSync(dir).type,filesystem:statfsSync(dir).type===0x01021994?'tmpfs':statfsSync(dir).type===0xef53?'ext-family':'other',benchmarkRoot:process.env.DATABASE_BENCH_ROOT??tmpdir(),records:1000,snapshotBytes:(await stat(join(dir,'node.db'))).size,nodeBackup:stats(times),pythonBackupThread:stats(JSON.parse(result.stdout)),nodeEventLoopMaxMs:Math.max(...delays),scope:'Same WAL source and original Python provider thread. Node also stages, fsyncs and atomically publishes replacement; filesystem and process checks, not hardware power-loss acceptance'},null,2));
}finally{await store.close();await rm(dir,{recursive:true,force:true});}
