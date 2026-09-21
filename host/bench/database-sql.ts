import {mkdtemp,rm} from 'node:fs/promises';
import {statfsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {databaseOracle} from '../test/helpers/database-oracle.ts';
const dir=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'sql-bench-')),times:number[]=[],delays:number[]=[];
try{
 for(let run=0;run<7;run++){
  const store=await DatabaseStore.open({path:join(dir,'node'+run)}),loop=monitorEventLoopDelay({resolution:1});
  try{
   await store.registerTable({name:'jobs',prototype:'jobs (id INTEGER PRIMARY KEY,value REAL)',version:1});await store.sealTableRegistration();
   const operations=process.env.SQL_MANY==='1'?[{sql:'INSERT OR REPLACE INTO jobs VALUES(?,?)',many:Array.from({length:100},(_,i)=>[i,2.675])}]:Array.from({length:100},(_,i)=>({sql:'INSERT OR REPLACE INTO jobs VALUES(?,?)',params:[i,2.675]}));
   loop.enable();const start=performance.now();
   for(let batch=0;batch<20;batch++){
    const results=await store.sql(['jobs'],[...operations,{sql:'SELECT * FROM jobs ORDER BY id'}]);assert.equal(results.length,operations.length+1);assert.equal(results.at(-1)!.rows.length,100);assert.deepEqual(results.at(-1)!.rows[99],[99,2.675]);
   }
   const elapsed=performance.now()-start;if(run>=2){times.push(elapsed);delays.push(loop.max/1e6);}
  }finally{loop.disable();await store.close();}
 }
 const base=databaseOracle().slice(0,databaseOracle().indexOf('def main():'));
 const program=base+String.raw`
import os,concurrent.futures
methods=[n for n in provider.body if isinstance(n,ast.FunctionDef) and n.name in {'sql_execute','sql_executemany','sql_commit','sql_rollback'}]
exec('from __future__ import annotations\nclass SQLProvider:\n'+textwrap.indent(ast.unparse(ast.Module(body=methods,type_ignores=[])),'    '))
SqliteCursorProxy=lambda provider,cursor:cursor
values=[]
for run in range(7):
 with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
  def setup():
   global conn,owner
   conn=sqlite3.connect(os.path.join(sys.argv[1],'py'+str(run)));conn.execute('PRAGMA journal_mode=WAL');conn.execute('PRAGMA synchronous=FULL');conn.execute('CREATE TABLE jobs (id INTEGER PRIMARY KEY,value REAL)');conn.commit();owner=SQLProvider()
  pool.submit(setup).result()
  def batch():
   conn.execute('BEGIN IMMEDIATE')
   try:
    if sys.argv[2]=='1': owner.sql_executemany(conn,'INSERT OR REPLACE INTO jobs VALUES(?,?)',[(i,2.675) for i in range(100)])
    else:
     for i in range(100): owner.sql_execute(conn,'INSERT OR REPLACE INTO jobs VALUES(?,?)',(i,2.675))
    rows=owner.sql_execute(conn,'SELECT * FROM jobs ORDER BY id',[]).fetchall();owner.sql_commit(conn);return rows
   except: owner.sql_rollback(conn);raise
  start=time.perf_counter()
  for i in range(20):
   rows=pool.submit(batch).result();assert len(rows)==100 and rows[-1]==(99,2.675)
  if run>=2:values.append((time.perf_counter()-start)*1000)
  pool.submit(conn.close).result()
print(json.dumps(values))
`;
 const py=spawnSync('/usr/bin/python3',['-c',program,dir,process.env.SQL_MANY??'0'],{encoding:'utf8'});assert.equal(py.status,0,py.stderr);
 const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[2],p95Ms:a.at(-1)};};
 console.log(JSON.stringify({node:process.version,many:process.env.SQL_MANY==='1',filesystemMagic:statfsSync(dir).type,nodeWorker:stats(times),pythonThread:stats(JSON.parse(py.stdout)),eventLoopMaxMs:Math.max(...delays),scope:'20 transactions of 100 upserts and 100-row read, WAL/FULL. Python pinned SQL methods grouped into one thread call, omitting individual cursor/future round trips and write acknowledgements; optimistic baseline, not full server or hardware.'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
