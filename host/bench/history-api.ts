import {mkdtemp,rm} from 'node:fs/promises';
import {statfsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {HistoryRepository} from '../src/moonraker/history-repository.ts';
import {registerHistory} from '../src/moonraker/history-api.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {historyOracle} from '../test/helpers/history-oracle.ts';
const root=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'history-api-bench-')),times:number[]=[],delays:number[]=[];
const db=await DatabaseStore.open({path:join(root,'db')});
try{
 const history=await HistoryRepository.open(db);await db.sealTableRegistration();
 await db.sql(['job_history'],[{sql:"INSERT INTO job_history VALUES(?,'No User','part.gcode','completed',?,?,1,2,2.675,'{}','[]','default')",many:Array.from({length:200},(_,i)=>[i+1,100+i,200+i])}]);
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),release=registerHistory(registry,{repository:history,fileExists:()=>false}),context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
 try{
  for(let run=0;run<7;run++){
   const loop=monitorEventLoopDelay({resolution:1});loop.enable();const start=performance.now();
   try{for(let i=0;i<50;i++){const result=await registry.invoke('/server/history/list','GET',{limit:50,start:50},context) as any;assert.equal(result.count,50);assert.equal(result.jobs[0].job_id,'000096');assert.equal(result.jobs[49].job_id,'000065');}if(run>=2){times.push(performance.now()-start);delays.push(loop.max/1e6);}}finally{loop.disable();}
  }
 }finally{release();}
 const program=historyOracle().split('async def main():')[0].replace("sqlite3.connect(':memory:',detect_types=sqlite3.PARSE_DECLTYPES)","sqlite3.connect(sys.argv[1],detect_types=sqlite3.PARSE_DECLTYPES)").replace('conn.row_factory=sqlite3.Row',"conn.row_factory=sqlite3.Row;conn.execute('PRAGMA journal_mode=WAL');conn.execute('PRAGMA synchronous=FULL')")+String.raw`
conn.commit()
samples=[]
async def bench():
 for run in range(7):
  start=time.perf_counter()
  for i in range(50):
   value=await owner._handle_jobs_list(Request({'limit':50,'start':50}))
   assert value['count']==50 and value['jobs'][0]['job_id']=='000096' and value['jobs'][-1]['job_id']=='000065'
  if run>=2:samples.append((time.perf_counter()-start)*1000)
asyncio.run(bench())
print(json.dumps(samples))
`;
 const py=spawnSync('/usr/bin/python3',['-c',program,join(root,'python')],{input:JSON.stringify({rows:Array.from({length:200},(_,i)=>({id:i+1,start:100+i,end:200+i}))}),encoding:'utf8'});assert.equal(py.status,0,py.stderr);
 const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[2],p95Ms:a.at(-1)};};
 console.log(JSON.stringify({node:process.version,filesystemMagic:statfsSync(root).type,nodeEndpoint:stats(times),pythonHandler:stats(JSON.parse(py.stdout)),eventLoopMaxMs:Math.max(...delays),scope:'50 paginated lists of 50 rows from 200 rows. Both WAL/FULL files; Node Worker+endpoint; pinned Python handler direct async adapter, omits provider thread. Both file-existence checks return false without I/O. Not HTTP, filesystem checking or print-speed acceptance.'},null,2));
}finally{await db.close();await rm(root,{recursive:true,force:true});}
