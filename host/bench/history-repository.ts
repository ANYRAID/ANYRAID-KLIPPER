import {mkdtemp,rm} from 'node:fs/promises';
import {statfsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {HistoryRepository} from '../src/moonraker/history-repository.ts';
import {historyOracle} from '../test/helpers/history-oracle.ts';
const root=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'history-bench-')),times:number[]=[],delays:number[]=[];
const data={filename:'part.gcode',start_time:100,total_duration:30,print_duration:25,filament_used:2.675,metadata:{size:1000},auxiliary_data:[]};
try{
 for(let run=0;run<7;run++){
  const db=await DatabaseStore.open({path:join(root,'node'+run)}),loop=monitorEventLoopDelay({resolution:1});
  try{
   const history=await HistoryRepository.open(db);await db.sealTableRegistration();loop.enable();const start=performance.now();
   for(let i=0;i<25;i++){const job=await history.start(data);await history.finish(job.job_id,'completed',data,130);}
   const elapsed=performance.now()-start;if(run>=2){times.push(elapsed);delays.push(loop.max/1e6);}
   assert.equal((await history.totals()).total_jobs,25);assert.equal((await history.totals()).total_time,750);assert.equal((await history.list({limit:0})).count,25);
  }finally{loop.disable();await db.close();}
 }
 const program=historyOracle().split('data=json.load(sys.stdin)')[0]+String.raw`
import os,concurrent.futures
methods=[n for n in history.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in {'save_job','_update_job_totals','_accumulate_total','_maximize_total','_update_aux_totals'}]
exec('from __future__ import annotations\nclass Writer:\n'+__import__('textwrap').indent(ast.unparse(ast.Module(body=methods,type_ignores=[])),'    '))
fn=next(n for n in source.body if isinstance(n,ast.FunctionDef) and n.name=='_create_totals_list')
exec('from __future__ import annotations\n'+ast.unparse(fn))
sqlite3.register_adapter(dict,lambda value:json.dumps(value).encode())
sqlite3.register_adapter(list,lambda value:json.dumps(value).encode())
class Tx:
 async def __aenter__(self):return self
 async def __aexit__(self,kind,value,trace):
  if kind is None:conn.commit()
  else:conn.rollback()
 async def execute(self,sql,values):
  cursor=conn.execute(sql,values);return types.SimpleNamespace(lastrowid=cursor.lastrowid)
 async def executemany(self,sql,values):conn.executemany(sql,values)
samples=[]
for run in range(7):
 with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
  def setup():
   global conn,owner
   conn=sqlite3.connect(os.path.join(sys.argv[1],'py'+str(run)));conn.execute('PRAGMA journal_mode=WAL');conn.execute('PRAGMA synchronous=FULL')
   for definition in [HistorySqlDefinition,TotalsSqlDefinition]:conn.execute('CREATE TABLE '+inspect.cleandoc(definition.prototype))
   conn.commit();owner=Writer();owner.history_table=owner.totals_table=Tx();owner.auxiliary_fields=[];owner.aux_totals=[];owner.job_totals=dict(total_jobs=0,total_time=0.,total_print_time=0.,total_filament_used=0.,longest_job=0.,longest_print=0.)
  pool.submit(setup).result()
  async def cycle():
   owner.current_job=PrinterJob(dict(filename='part.gcode',start_time=100,total_duration=30,print_duration=25,filament_used=2.675,metadata={'size':1000}))
   ident=await owner.save_job(owner.current_job,None)
   owner.current_job.finish('completed',{});await owner.save_job(owner.current_job,ident);await owner._update_job_totals()
  start=time.perf_counter()
  for i in range(25):pool.submit(lambda:asyncio.run(cycle())).result()
  elapsed=(time.perf_counter()-start)*1000
  assert owner.job_totals['total_jobs']==25 and owner.job_totals['total_time']==750
  if run>=2:samples.append(elapsed)
  pool.submit(conn.close).result()
print(json.dumps(samples))
`;
 const py=spawnSync('/usr/bin/python3',['-c',program,root],{encoding:'utf8'});assert.equal(py.status,0,py.stderr);
 const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[2],p95Ms:a.at(-1)};};
 console.log(JSON.stringify({node:process.version,filesystemMagic:statfsSync(root).type,nodeWorker:stats(times),pythonThread:stats(JSON.parse(py.stdout)),eventLoopMaxMs:Math.max(...delays),scope:'25 start/finish/total cycles, WAL/FULL, excludes setup and final assertions. Node atomic finish/totals, upstream separate transactions. Python methods grouped per job in one thread, async loop per cycle. No file metadata or notifications; not full server or print-speed evidence.'},null,2));
}finally{await rm(root,{recursive:true,force:true});}
