import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PrintController,type PrintDevice} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {ProductPrintApi} from '../src/moonraker/product-print-api.ts';
import type {PressureAdvancePort} from '../src/gcode/pressure-advance.ts';
const input={version:1 as const,requestId:'job',fileId:'file',nozzle:200,bed:60,expiresAt:Date.now()+3600000};
const params={version:1,request_id:'job',file_id:'file',nozzle:200,bed:60,expires_at:input.expiresAt};
async function fixture(run:(controller:PrintController,api:ProductPrintApi,journal:PrintJournal,calls:string[],release:()=>void,gate:MaintenanceGate)=>Promise<void>,pressure?:PressureAdvancePort){
 const dir=await mkdtemp(join(tmpdir(),'product-print-')),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'}),calls:string[]=[],ready=Promise.withResolvers<void>(),gate=new MaintenanceGate();
 const device:PrintDevice={async prepare(_request,signal){calls.push('prepare');await Promise.race([ready.promise,new Promise<void>((_r,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))]);},async start(){calls.push('start');},async pause(){calls.push('pause');},async resume(){calls.push('resume');},async finish(){},async stop(){calls.push('stop');}};
 const controller=new PrintController(device,{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate}),api=new ProductPrintApi(controller,gate,pressure);
 try{await run(controller,api,journal,calls,()=>ready.resolve(),gate);}finally{ready.resolve();await api.close();await journal.close();await rm(dir,{recursive:true,force:true});}
}
const context=(signal=new AbortController().signal)=>({transport:'http' as const,signal,authorize:()=>{}});
test('typed pressure admission rejects invalid and stale controls; disconnected client cannot replay or cancel accepted tuning',async()=>{
 let state={advance:.1,smoothTime:.04},count=0;const entered=Promise.withResolvers<void>(),done=Promise.withResolvers<void>();
 const pressure:PressureAdvancePort={name:'extruder',get pressureAdvance(){return state;},async applyPressureAdvance(change,signal){count++;entered.resolve();await done.promise;signal.throwIfAborted();state={...change.next};}};
 await fixture(async(controller,api,_journal,_calls,release,gate)=>{
  release();await controller.start(input);const settings={version:1,request_id:'job',state_token:controller.stateToken,extruder:'extruder',advance:.2,smooth_time:.08};
  await assert.rejects(api.call('pressure_advance',settings,context()),/not completed/);assert.equal(count,0);await controller.pause();settings.state_token=controller.stateToken;
  for(const invalid of [{advance:'0.2'},{smooth_time:.3},{version:2},{extruder:'other'},{script:'G1 X1'}] as Record<string,string|number>[])await assert.rejects(api.call('pressure_advance',{...settings,...invalid},context()),/requires|Invalid/);
  assert.equal(controller.stateToken,settings.state_token);assert.equal(count,0);
  const abort=new AbortController(),response=api.call('pressure_advance',settings,context(abort.signal)),cancelled=assert.rejects(response,/response cancelled/);await entered.promise;settings.advance=99;
  const admitted=controller.stateToken;assert.notEqual(admitted,settings.state_token);assert.equal(gate.status.activities,1);assert.throws(()=>gate.acquire());
  await assert.rejects(api.call('pressure_advance',settings,context()),/state token/);await assert.rejects(api.call('resume',{request_id:'job',state_token:admitted},context()),/not completed/);
  abort.abort();await cancelled;assert.equal(controller.state,'paused');assert.deepEqual(state,{advance:.1,smoothTime:.04});done.resolve();
  for(let i=0;i<20&&controller.stateToken===admitted;i++)await new Promise<void>(r=>setImmediate(r));
  assert.notEqual(controller.stateToken,admitted);assert.deepEqual(state,{advance:.2,smoothTime:.08});assert.equal(count,1);assert.equal(gate.status.activities,0);
 },pressure);
});
test('Native admission responds after durable reservation while preparation continues and retries cannot change identity',()=>fixture(async(controller,api,journal,calls,release)=>{
 const response=await api.call('start',params,context()) as any;assert.equal(response.accepted,true);assert.equal(response.current.state,'preparing');assert.equal((await journal.get('job'))?.state,'reserved');assert.deepEqual(calls,['prepare']);
 await api.call('start',params,context());assert.deepEqual(calls,['prepare']);await assert.rejects(api.call('start',{...params,file_id:'other'},context()),/not completed/);
 await assert.rejects(api.call('cancel',{request_id:'other',state_token:controller.stateToken},context()),/current request/);await assert.rejects(api.call('reset',{request_id:'job',state_token:controller.stateToken},context()),/state/);release();await controller.start(input);assert.equal(controller.state,'printing');await api.call('pause',{request_id:'job',state_token:controller.stateToken},context());assert.equal(controller.state,'paused');await api.call('resume',{request_id:'job',state_token:controller.stateToken},context());assert.equal(controller.state,'printing');await api.call('cancel',{request_id:'job',state_token:controller.stateToken},context());assert.equal((await journal.get('job'))?.state,'cancelled');await api.call('reset',{request_id:'job',state_token:controller.stateToken},context());assert.equal(controller.state,'idle');const queried=await api.call('status',{request_id:'job'},context()) as any;assert.equal(queried.record.state,'cancelled');assert.equal(queried.record.request.request_id,'job');assert.equal(queried.current.state,'idle');
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
