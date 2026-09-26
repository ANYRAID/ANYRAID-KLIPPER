import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {PrintController} from '../src/operations/print.ts';
import {ExtrusionAccounting} from '../src/gcode/extrusion-accounting.ts';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {NativePrintUploads} from '../src/moonraker/native-print-uploads.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {registerNativeHistory} from '../src/moonraker/native-history.ts';
import {JsonRpcDispatcher,ApiError} from '../src/moonraker/rpc.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
test('native standard history reads actual live and durable jobs through authenticated HTTP and RPC without erasing requests',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-history-')),options={path:join(dir,'jobs.db'),deviceId:'printer'};let journal=await PrintJournal.open(options);
 const gate=new MaintenanceGate(),meter=new ExtrusionAccounting(),controller=new PrintController({async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){}},{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate,extrusionAccounting:meter}),files=await PublishedPrintFiles.open(join(dir,'files')),uploads=new NativePrintUploads(files,gate,{stagingRoot:dir}),rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc),release=registerNativeHistory(registry,controller,uploads),network=new MoonrakerNetwork(rpc,{endpoints:registry,authorize(_m,_p,ctx){if(ctx.request.headers['x-api-key']!=='test')throw new ApiError(401,'Denied');}});
 try{
  const source=join(dir,'source');await writeFile(source,'G1 E4\n');const file=await open(source,'r');try{await files.publish('file','part.gcode',file,new AbortController().signal);}finally{await file.close();}
  const {port}=await network.listen(),base=`http://127.0.0.1:${port}`,headers={'x-api-key':'test'};
  const get=async(path:string)=>{const response=await fetch(base+path,{headers});assert.equal(response.status,200);return (await response.json()).result;};
  assert.equal((await fetch(base+'/server/history/list')).status,401);assert.deepEqual(await get('/server/history/list'),{count:0,jobs:[]});
  const request={version:1 as const,requestId:'z-first',fileId:'file',nozzle:0,bed:0};await controller.start(request);assert.equal((await fetch(base+'/server/history/reset_totals',{method:'POST',headers})).status,409);meter.accepted(0,4,1);const active=await get('/server/history/list');assert.equal(active.jobs[0].status,'in_progress');assert.equal(active.jobs[0].filament_used,4);assert.equal(active.jobs[0].end_time,null);assert.equal((await fetch(base+'/server/history/job?uid=1',{method:'DELETE',headers})).status,409);await controller.complete(request.requestId);controller.reset(request.requestId);
  await controller.start({...request,requestId:'a-second'});await controller.cancel();
  const list=await get('/server/history/list');assert.equal(list.count,2);assert.deepEqual(list.jobs.map((j:any)=>j.job_id),['000002','000001']);assert.equal(list.jobs[1].filename,'file.gcode');assert.equal(list.jobs[1].filament_used,4);assert.equal(list.jobs[1].exists,true);assert.equal(list.jobs[1].metadata.native_request_id,'z-first');assert.equal(list.jobs[1].user,'unknown');
  assert.equal((await get('/server/history/list?order=asc&limit=1&start=1')).jobs[0].job_id,'000002');assert.equal((await get('/server/history/list?before=0')).count,0);assert.equal((await get('/server/history/list?since=-1&limit=0')).count,2);
  const response=await fetch(base+'/server/jsonrpc',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'server.history.get_job',params:{uid:'1'}})});assert.deepEqual((await response.json()).result.job,{...list.jobs[1],job_id:'1'});
  assert.equal((await fetch(base+'/server/history/job?uid=nope',{headers})).status,400);assert.equal((await fetch(base+'/server/history/job?uid=ABC',{headers})).status,404);assert.equal((await fetch(base+'/server/history/list?limit=1001',{headers})).status,413);assert.equal((await fetch(base+'/server/history/job?uid=1',{method:'DELETE'})).status,401);
  assert.equal((await get('/server/history/totals')).job_totals.total_jobs,2);assert.equal((await fetch(base+'/server/history/totals')).status,401);assert.equal((await fetch(base+'/server/history/reset_totals',{method:'POST'})).status,401);
  await journal.reserve({...request,requestId:'no-statistics'});await journal.transition('no-statistics',1,'cancelled');const unknown=await get('/server/history/job?uid=3');assert.equal(unknown.job.filament_used,null);assert.equal(unknown.job.print_duration,null);
  await files.remove('file',new AbortController().signal);const historical=await get('/server/history/job?uid=1');assert.equal(historical.job.exists,false);assert.equal(historical.job.filament_used,4);assert.equal((await journal.get('z-first'))!.state,'completed');
  const deletion=await fetch(base+'/server/jsonrpc',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'server.history.delete_job',params:{uid:'1'}})});assert.deepEqual((await deletion.json()).result,{deleted_jobs:['1']});assert.equal((await fetch(base+'/server/history/job?uid=1',{headers})).status,404);assert.equal((await get('/server/history/list')).count,2);assert.equal((await journal.get('z-first'))!.state,'completed');
  assert.equal((await fetch(base+'/server/history/job?all=invalid',{method:'DELETE',headers})).status,400);const allDeleted=await fetch(base+'/server/history/job?all=true',{method:'DELETE',headers});assert.deepEqual((await allDeleted.json()).result,{deleted_jobs:['000002','000003']});assert.equal((await get('/server/history/list')).count,0);
  const totals=await get('/server/history/totals');assert.equal(totals.job_totals.total_jobs,3);assert.equal(totals.job_totals.total_time,null);const reset=await fetch(base+'/server/jsonrpc',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:3,method:'server.history.reset_totals'})});assert.deepEqual((await reset.json()).result.last_totals,totals.job_totals);assert.equal((await get('/server/history/totals')).job_totals.total_jobs,0);assert.equal((await get('/server/history/list')).count,0);
  await controller.retire();await journal.close();journal=await PrintJournal.open(options);assert.equal(await journal.historyGet('1'),null);assert.equal((await journal.get('z-first'))!.request.requestId,'z-first');assert.equal((await journal.reserve(request)).created,false);
 }finally{await network.close();release();await controller.retire();await uploads.close();await files.close();await journal.close();await rm(dir,{recursive:true,force:true});}
});
