import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,stat,utimes,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {HistoryRepository} from '../src/moonraker/history-repository.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {registerHistory} from '../src/moonraker/history-api.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {ApiError,JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
const data={filename:'part.gcode',start_time:100,total_duration:30,print_duration:25,filament_used:2.675,metadata:{modified:99}};
async function fixture(run:(history:HistoryRepository,db:DatabaseStore,dir:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'history-api-'));const db=await DatabaseStore.open({path:join(dir,'db')});try{await run(await HistoryRepository.open(db),db,dir);}finally{await db.close();await rm(dir,{recursive:true,force:true});}}
test('configured history REST and JSON-RPC authorize reads and writes with real owner cleanup',()=>fixture(async(history,db,dir)=>{
 const file=join(dir,'part.gcode');await writeFile(file,'G1 X1');await utimes(file,99,99);
 const path=join(dir,'moonraker.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');let checks=0;
 const server=await ConfiguredMoonraker.load(path,{database:db,history:{repository:history,fileExists:async(filename,mtime,signal)=>{checks++;signal.throwIfAborted();if(filename!=='part.gcode')return false;try{const info=await stat(file);signal.throwIfAborted();return info.mtimeMs/1000===mtime;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}},information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize(_method,_params,context){if(context.request.headers['x-key']!=='test')throw new ApiError(401,'Denied');}});
 try{
  const job=await history.start(data);await history.finish(job.job_id,'completed',data,130);
  const address=await server.start(),url='http://127.0.0.1:'+address.port,headers={'x-key':'test','content-type':'application/json'};
  assert.equal((await fetch(url+'/server/history/list')).status,401);assert.equal(checks,0);
  assert.equal((await fetch(url+'/server/history/job?all=true',{method:'DELETE'})).status,401);assert.equal((await history.list()).count,1);
  const get:any=await(await fetch(url+'/server/history/job?uid=1',{headers})).json();assert.equal(get.result.job.job_id,'1');assert.equal(get.result.job.exists,true);
  const list:any=await(await fetch(url+'/server/history/list?limit=1&since=99.5&order=ASC',{headers})).json();assert.equal(list.result.count,1);assert.equal(list.result.jobs[0].job_id,'000001');
  await unlink(file);const gone:any=await(await fetch(url+'/server/history/job?uid=1',{headers})).json();assert.equal(gone.result.job.exists,false);
  const rpc=async(method:string,params={})=>(await(await fetch(url+'/server/jsonrpc',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json()) as any;
  assert.equal((await rpc('server.history.totals')).result.job_totals.total_jobs,1);
  assert.deepEqual((await rpc('server.history.delete_job',{uid:'1'})).result,{deleted_jobs:['1']});
  assert.equal((await rpc('server.history.reset_totals')).result.last_totals.total_jobs,1);
  assert.equal((await history.totals()).total_jobs,0);
 }finally{await server.close();}assert.equal(db.status.closed,true);
}));
test('history parameter conversions, file failure, cancellation and unregister remain observable',()=>fixture(async(history)=>{
 const first=await history.start(data);await history.finish(first.job_id,'completed',data,130);
 const rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc),abort=new AbortController(),context:RpcContext={transport:'http',signal:abort.signal,authorize(){}};
 let failed=false;const release=registerHistory(registry,{repository:history,fileExists:()=>{if(failed)throw new ApiError(503,'File owner unavailable');return false;}});
 const list=async(params:any)=>registry.invoke('/server/history/list','GET',params,context) as Promise<any>;
 assert.equal((await list({limit:'１',start:-1,before:'1_31.0',since:'-2',order:'asc'})).count,1);
 for(const params of [{limit:'1.5'},{before:'0x100'},{before:''},{since:'Infinity'},{limit:null}])await assert.rejects(list(params),e=>e instanceof ApiError&&e.status===400);
 await assert.rejects(registry.invoke('/server/history/job','DELETE',{all:1},context),e=>e instanceof ApiError&&e.status===400);
 failed=true;await assert.rejects(list({}),e=>e instanceof ApiError&&e.status===503);failed=false;
 abort.abort();await assert.rejects(list({}));release();
 await assert.rejects(registry.invoke('/server/history/list','GET',{}, {...context,signal:new AbortController().signal}),e=>e instanceof ApiError&&e.status===404);
}));
test('history get, deletion and base-total reset match pinned upstream handlers',()=>fixture(async(history)=>{
 const rows=[];for(let i=0;i<3;i++){const values={...data,start_time:100+i,total_duration:2,print_duration:1,metadata:{}},job=await history.start(values);await history.finish(job.job_id,'completed',values,200+i);rows.push({id:i+1,start:100+i,end:200+i});}
 const operations=[{method:'get',uid:'1'},{method:'delete',uid:'1'},{method:'deleteAll'},{method:'get',uid:'1'},{method:'reset'},{method:'totals'}];
 const {execFileSync}=await import('node:child_process'),{historyMutationOracle}=await import('./helpers/history-oracle.ts');
 const reference=JSON.parse(execFileSync('/usr/bin/python3',['-c',historyMutationOracle()],{input:JSON.stringify({rows,operations}),encoding:'utf8'}));
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),release=registerHistory(registry,{repository:history,fileExists:()=>false}),context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}},actual=[];
 try{for(const operation of operations){const method=operation.method;try{const value=await registry.invoke('/server/history/'+(method==='reset'?'reset_totals':method==='totals'?'totals':'job'),method==='reset'?'POST':method==='delete'||method==='deleteAll'?'DELETE':'GET',method==='deleteAll'?{all:true}:operation.uid?{uid:operation.uid}:{},context);actual.push({value});}catch(error){assert.ok(error instanceof ApiError);actual.push({error:error.status});}}assert.deepEqual(actual,reference);}finally{release();}
}));
test('configured history rejects mismatched database ownership without closing either store',()=>fixture(async(history,db,dir)=>{
 const path=join(dir,'wrong.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');const other=await DatabaseStore.open({path:join(dir,'other')});
 try{
  await assert.rejects(ConfiguredMoonraker.load(path,{database:other,history:{repository:history,fileExists:()=>false},information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize(){}}),/History requires/);
  assert.equal(db.status.closed,false);assert.equal(other.status.closed,false);assert.equal((await history.start(data)).job_id,'000001');
 }finally{await other.close();}
}));
test('configured auxiliary source owns reset fields and rejects a conflicting reset provider',()=>fixture(async(history,db,dir)=>{
 const path=join(dir,'auxiliary.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');
 const field={provider:'sensor',field:'energy',value:2.675,report_total:true,report_maximum:true,precision:2};
 const first=await history.start(data);await history.finish(first.job_id,'completed',data,130,undefined,{data:[],totals:[field]});
 const options={database:db,history:{repository:history,fileExists:()=>true,auxiliary:()=>({reset(){},snapshot:()=>({data:[],totals:[field]})})},information:{connected:false,state:'disconnected' as const,components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize(){}};
 await assert.rejects(ConfiguredMoonraker.load(path,{...options,history:{...options.history,auxiliaryTotals:()=>[]}}),/own its reset/);assert.equal(db.status.closed,false);
 const server=await ConfiguredMoonraker.load(path,options);try{
  const address=await server.start(),url='http://127.0.0.1:'+address.port;
  const result:any=await(await fetch(url+'/server/history/reset_totals',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json();assert.equal(result.result.last_auxiliary_totals[0].total,2.67);assert.equal((await history.allTotals()).auxiliary_totals[0].total,0);
 }finally{await server.close();}
}));
