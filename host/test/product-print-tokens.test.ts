import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PrintController,type PrintDevice} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {ProductPrintApi} from '../src/moonraker/product-print-api.ts';
const request={version:1 as const,requestId:'job',fileId:'file',nozzle:200,bed:60,expiresAt:Date.now()+3600000};
const context={transport:'http' as const,signal:new AbortController().signal,authorize:()=>{}};
async function fixture(t:TestContext){
 const dir=await mkdtemp(join(tmpdir(),'print-token-')),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'}),gate=new MaintenanceGate(),calls:string[]=[];
 const device:PrintDevice={async prepare(){calls.push('prepare');},async start(){calls.push('start');},async pause(){calls.push('pause');},async resume(){calls.push('resume');},async finish(){calls.push('finish');},async stop(){calls.push('stop');}};
 const controller=new PrintController(device,{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate}),api=new ProductPrintApi(controller,gate);
 t.after(async()=>{try{await api.close();}finally{await journal.close();await rm(dir,{recursive:true,force:true});}});return {controller,api,device,calls};
}
test('State tokens reject delayed same-job commands and the comparison precedes a competing transition',async t=>{
 const {controller,api,device,calls}=await fixture(t);await controller.start(request);const initial=api.status.state_token;assert.equal(initial,api.status.state_token);
 const release=Promise.withResolvers<void>();t.mock.method(device,'pause',async(signal:AbortSignal)=>{calls.push('pause');await Promise.race([release.promise,new Promise<void>((_r,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))]);});
 const paused=api.call('pause',{request_id:'job',state_token:initial},context);
 try{assert.equal(controller.state,'pausing');assert.notEqual(controller.stateToken,initial);await assert.rejects(api.call('pause',{request_id:'job',state_token:initial},context),/state changed/);}
 finally{release.resolve();}await paused;
 const pausedToken=controller.stateToken;await api.call('resume',{request_id:'job',state_token:pausedToken},context);assert.equal(controller.state,'printing');assert.notEqual(controller.stateToken,initial);
 await assert.rejects(api.call('pause',{request_id:'job',state_token:initial},context),/state changed/);await assert.rejects(api.call('cancel',{request_id:'job'},context),/state_token/);assert.deepEqual(calls,['prepare','start','pause','resume']);
});
test('Emergency stop does not require a state token and latches the controller against restart',async t=>{
 const {controller,api,calls}=await fixture(t);await controller.start(request);const old=controller.stateToken;
 await api.call('emergency_stop',{},context);assert.notEqual(controller.stateToken,old);assert.equal(controller.state,'failed');assert.deepEqual(calls,['prepare','start','stop']);
 await assert.rejects(api.call('resume',{request_id:'job',state_token:old},context),/state changed/);await assert.rejects(controller.start({...request,requestId:'new'}),/reinitialization/);await api.call('emergency_stop',{},context);assert.deepEqual(calls,['prepare','start','stop']);
});
test('Recreated controller epochs invalidate old tokens even for the same interrupted request',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'print-token-recovery-')),options={path:join(dir,'jobs.db'),deviceId:'printer'},calls:string[]=[],device:PrintDevice={async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){calls.push('stop');}};let journal=await PrintJournal.open(options),api:ProductPrintApi|undefined;
 try{await journal.reserve(request);await journal.close();journal=await PrintJournal.open(options);const first=await PrintController.restore(device,{maxNozzle:300,maxBed:120},{},{journal});const old=first.stateToken;await journal.close();journal=await PrintJournal.open(options);
  const gate=new MaintenanceGate(),second=await PrintController.restore(device,{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate});api=new ProductPrintApi(second,gate);assert.notEqual(second.stateToken,old);await assert.rejects(api.call('cancel',{request_id:'job',state_token:old},context),/state changed/);assert.deepEqual(calls,[]);
  await api.call('cancel',{request_id:'job',state_token:second.stateToken},context);assert.equal(second.state,'cancelled');assert.deepEqual(calls,['stop']);
 }finally{await api?.close();await journal.close();await rm(dir,{recursive:true,force:true});}
});
