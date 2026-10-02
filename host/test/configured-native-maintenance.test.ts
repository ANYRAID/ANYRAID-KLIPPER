import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
import {PrintController,type PrintDevice} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
const job={version:1 as const,requestId:'job',fileId:'file',nozzle:0,bed:0};
async function fixture(overrides:Partial<PrintDevice>={},interrupted=false){
 const dir=await mkdtemp(join(tmpdir(),'native-maintenance-')),path=join(dir,'active.db'),gate=new MaintenanceGate();let journal=await PrintJournal.open({path:join(dir,'print.db'),deviceId:'printer'});
 if(interrupted){await journal.reserve(job);await journal.close();journal=await PrintJournal.open({path:join(dir,'print.db'),deviceId:'printer'});}
 const calls:string[]=[],device:PrintDevice={async prepare(){calls.push('prepare');},async start(){calls.push('start');},async pause(){},async resume(){},async finish(){},async stop(){calls.push('stop');},...overrides};
 const controller=await PrintController.restore(device,{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate}),database=await DatabaseStore.open({path,backupDirectory:join(dir,'backups')});let restarts=0;
 const config=join(dir,'moonraker.conf');await writeFile(config,'[server]\nhost=127.0.0.1\nport=0');
 const service=await ConfiguredMoonraker.load(config,{productPrint:controller,maintenanceGate:gate,database,onDatabaseRestore:()=>{restarts++;},information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize(_method,_params,context){if(context.request.headers['x-key']!=='test')throw new ApiError(401,'Denied');}});
 const address=await service.start();
 return {dir,path,gate,journal,controller,database,service,calls,get restarts(){return restarts;},async post(route:string,params:unknown={},authorized=true){return fetch(`http://127.0.0.1:${address.port}${route}`,{method:'POST',headers:{'content-type':'application/json',...authorized?{'x-key':'test'}:{}},body:JSON.stringify(params)});},async close(){await service.close();await journal.close();await rm(dir,{recursive:true,force:true});}};
}
test('native idle database backup and compaction work without Klippy and retain request authorization',async()=>{
 const f=await fixture();try{
  await f.database.insert('ui','setting','saved');assert.equal(f.service.klippy,null);
  assert.equal((await f.post('/server/database/backup',{filename:'saved.db'},false)).status,401);assert.deepEqual((await f.database.list() as {backups:string[]}).backups,[]);
  assert.equal((await f.post('/server/database/backup',{filename:'saved.db'})).status,200);
  assert.equal((await f.post('/server/database/compact')).status,200);assert.equal(await f.database.get('ui','setting'),'saved');assert.deepEqual(f.calls,[]);
  assert.equal((await f.post('/server/database/restore',{filename:'missing.db'})).status,404);assert.equal(f.gate.status.closed,false);assert.equal(f.gate.status.maintenance,false);assert.equal(f.restarts,0);
 }finally{await f.close();}
});
test('native maintenance excludes preparation, printing, paused, final drain and pending stop',async()=>{
 const prepared=Promise.withResolvers<void>(),finished=Promise.withResolvers<void>(),stopped=Promise.withResolvers<void>();
 const f=await fixture({prepare:()=>prepared.promise,finish:()=>finished.promise,stop:()=>stopped.promise});
 const blocked=async()=>{for(const route of ['backup','compact','restore'])assert.equal((await f.post('/server/database/'+route,{filename:'saved.db'})).status,409);};
 try{
  const started=f.controller.start(job);await blocked();prepared.resolve();await started;await blocked();await f.controller.pause();await blocked();await f.controller.resume();
  const finishing=f.controller.complete('job');await blocked();finished.resolve();await finishing;assert.equal((await f.post('/server/database/backup',{filename:'saved.db'})).status,200);
  f.controller.reset('job');await f.controller.start({...job,requestId:'second'});const cancelling=f.controller.cancel();await blocked();stopped.resolve();await cancelling;assert.equal((await f.post('/server/database/compact')).status,200);
  await f.controller.fault(new Error('device shutdown'));await blocked();
 }finally{prepared.resolve();finished.resolve();stopped.resolve();await f.close();}
});
test('native maintenance holds print admission through worker completion without consuming a rejected request ID',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),settled=Promise.withResolvers<void>(),backup=f.database.backup.bind(f.database);
 f.database.backup=async filename=>{const result=await backup(filename);entered.resolve();await settled.promise;return result;};
 const params={version:1,request_id:'later',file_id:'file',nozzle:0,bed:0,expires_at:Date.now()+60000};
 try{
  const pending=f.post('/server/database/backup',{filename:'saved.db'});await entered.promise;
  assert.equal((await f.post('/printer/print/start',params)).status,409);assert.equal(await f.journal.get('later'),null);assert.deepEqual(f.calls,[]);
  settled.resolve();assert.equal((await pending).status,200);assert.equal((await f.post('/printer/print/start',params)).status,200);
  await f.controller.start({...job,requestId:'later',expiresAt:params.expires_at});assert.deepEqual(f.calls,['prepare','start']);
 }finally{settled.resolve();await f.close();}
});
test('native restore requests owner restart and permanently fences the old print generation',async()=>{
 const f=await fixture();try{
  await f.database.insert('ui','generation',1);assert.equal((await f.post('/server/database/backup',{filename:'saved.db'})).status,200);await f.database.insert('ui','generation',2);
  const response=await f.post('/server/database/restore',{filename:'saved.db'});assert.equal(response.status,200);await response.json();
  const until=Date.now()+2000;while(!f.restarts){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,5));}
  assert.equal(f.restarts,1);assert.equal(f.gate.status.closed,true);assert.equal(f.service.databaseRestoreStatus.state,'restored');
  assert.equal((await f.post('/printer/print/start',{version:1,request_id:'blocked',file_id:'file',nozzle:0,bed:0,expires_at:Date.now()+60000})).status,409);assert.equal(await f.journal.get('blocked'),null);assert.deepEqual(f.calls,[]);
  await f.service.close();const reopened=await DatabaseStore.open({path:f.path});try{assert.equal(await reopened.get('ui','generation'),1);}finally{await reopened.close();}
 }finally{await f.close();}
});
test('interrupted or failed preparation requires acknowledged cancellation before native maintenance',async()=>{
 const f=await fixture({},true);try{assert.equal(f.controller.state,'interrupted');assert.equal((await f.post('/server/database/compact')).status,409);await f.controller.cancel();assert.equal((await f.post('/server/database/compact')).status,200);}finally{await f.close();}
 const failed=await fixture({async prepare(){throw new Error('invalid file');}});try{
  await assert.rejects(failed.controller.start(job),/invalid file/);assert.equal((await failed.post('/server/database/compact')).status,409);
  await failed.controller.cancel();assert.equal(failed.controller.state,'cancelled');assert.ok(failed.controller.failure);assert.equal((await failed.post('/server/database/compact')).status,200);
 }finally{await failed.close();}
});
