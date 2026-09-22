import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PrintController,type PrintDevice} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {ProductPrintApi} from '../src/moonraker/product-print-api.ts';
const input={version:1 as const,requestId:'job',fileId:'file',nozzle:200,bed:60,expiresAt:Date.now()+3600000};
const params={version:1,request_id:'job',file_id:'file',nozzle:200,bed:60,expires_at:input.expiresAt};
async function fixture(run:(controller:PrintController,api:ProductPrintApi,journal:PrintJournal,calls:string[],release:()=>void,gate:MaintenanceGate)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'product-print-')),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'}),calls:string[]=[],ready=Promise.withResolvers<void>(),gate=new MaintenanceGate();
 const device:PrintDevice={async prepare(_request,signal){calls.push('prepare');await Promise.race([ready.promise,new Promise<void>((_r,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))]);},async start(){calls.push('start');},async pause(){calls.push('pause');},async resume(){calls.push('resume');},async finish(){},async stop(){calls.push('stop');}};
 const controller=new PrintController(device,{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate}),api=new ProductPrintApi(controller,gate);
 try{await run(controller,api,journal,calls,()=>ready.resolve(),gate);}finally{ready.resolve();await api.close();await journal.close();await rm(dir,{recursive:true,force:true});}
}
const context=(signal=new AbortController().signal)=>({transport:'http' as const,signal,authorize:()=>{}});
test('Native admission responds after durable reservation while preparation continues and retries cannot change identity',()=>fixture(async(controller,api,journal,calls,release)=>{
 const response=await api.call('start',params,context()) as any;assert.equal(response.accepted,true);assert.equal(response.current.state,'preparing');assert.equal((await journal.get('job'))?.state,'reserved');assert.deepEqual(calls,['prepare']);
 await api.call('start',params,context());assert.deepEqual(calls,['prepare']);await assert.rejects(api.call('start',{...params,file_id:'other'},context()),/not completed/);
 await assert.rejects(api.call('cancel',{request_id:'other'},context()),/current request/);await assert.rejects(api.call('reset',{request_id:'job'},context()),/state/);release();await controller.start(input);assert.equal(controller.state,'printing');await api.call('pause',{request_id:'job'},context());assert.equal(controller.state,'paused');await api.call('resume',{request_id:'job'},context());assert.equal(controller.state,'printing');await api.call('cancel',{request_id:'job'},context());assert.equal((await journal.get('job'))?.state,'cancelled');await api.call('reset',{request_id:'job'},context());assert.equal(controller.state,'idle');const queried=await api.call('status',{request_id:'job'},context()) as any;assert.equal(queried.record.state,'cancelled');assert.equal(queried.record.request.request_id,'job');assert.equal(queried.current.state,'idle');
}));
test('Client cancellation stops receipt waiting without undoing an admitted print; server close performs safe cancellation',()=>fixture(async(controller,api,journal,calls)=>{
 const abort=new AbortController();const response=api.call('start',params,context(abort.signal));abort.abort();await assert.rejects(response,/response cancelled/);
 await controller.admit(input);assert.equal(controller.state,'preparing');assert.equal((await journal.get('job'))?.state,'reserved');assert.deepEqual(calls,['prepare']);await api.close();assert.equal(controller.state,'cancelled');assert.deepEqual(calls,['prepare','stop','stop']);
}));
test('Native control rejects missing expiry, legacy start shape and expired requests before effects',()=>fixture(async(_controller,api,journal,calls)=>{
 for(const value of [{filename:'file.gcode'}, {...params,expires_at:null}, {...params,expires_at:-1},{...params,extra:true}] as Parameters<ProductPrintApi['call']>[1][])await assert.rejects(api.call('start',value,context()),/requires/);
 await assert.rejects(api.call('start',{...params,expires_at:0},context()),/expired/);assert.deepEqual(calls,[]);assert.equal(await journal.get('job'),null);
}));
test('Native API requires a durable single owner and matching maintenance gate',()=>fixture(async(controller,api,_journal,_calls,_release,sharedGate)=>{
 const gate=new MaintenanceGate(),target:PrintDevice={async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){}};
 assert.throws(()=>new ProductPrintApi(new PrintController(target,{maxNozzle:300,maxBed:120}),gate),/durable controller/);
 assert.throws(()=>new ProductPrintApi(controller,gate),/durable controller/);assert.throws(()=>new ProductPrintApi(controller,sharedGate),/unowned/);assert.equal(api.status.closed,false);
}));
test('Native close retains failure and allows an explicit cleanup retry',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'product-close-')),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'}),gate=new MaintenanceGate();let fail=true;
 const target:PrintDevice={async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){if(fail)throw new Error('test stop unavailable');}},controller=new PrintController(target,{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate}),api=new ProductPrintApi(controller,gate);
 try{await controller.start(input);await assert.rejects(api.close(),/stop unavailable/);assert.equal(api.status.closed,true);fail=false;await api.close();assert.equal(controller.state,'cancelled');assert.equal((await journal.get('job'))?.state,'cancelled');}
 finally{fail=false;await api.close();await journal.close();await rm(dir,{recursive:true,force:true});}
});
