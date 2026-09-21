import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MaintenanceGate,MaintenanceBusyError} from '../src/operations/maintenance-gate.ts';
import {PrintController,type PrintDevice} from '../src/operations/print.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,ApiError,type RpcContext} from '../src/moonraker/rpc.ts';
import {registerDatabaseMaintenance} from '../src/moonraker/database-maintenance.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const request={version:1 as const,requestId:'job1',fileId:'file1',nozzle:210,bed:60};
function printer(gate:MaintenanceGate,overrides:Partial<PrintDevice>={}){const noop=async()=>{};return new PrintController({prepare:noop,start:noop,pause:noop,resume:noop,finish:noop,stop:noop,...overrides},{maxNozzle:280,maxBed:110},{},{maintenanceGate:gate});}
const deferred=()=>Promise.withResolvers<void>();
test('leases exclude opposite admission, release once, and never reopen invalidated generations',()=>{
 const gate=new MaintenanceGate(),activity=gate.activity();assert.throws(()=>gate.acquire(),MaintenanceBusyError);activity();activity();assert.equal(gate.status.activities,0);
 const maintenance=gate.acquire();assert.throws(()=>gate.activity(),MaintenanceBusyError);assert.throws(()=>gate.registerIdle(()=>true),MaintenanceBusyError);gate.invalidate();maintenance();maintenance();assert.throws(()=>gate.activity(),MaintenanceBusyError);assert.throws(()=>gate.acquire(),MaintenanceBusyError);
});
test('failed or throwing idle probes release maintenance admission',()=>{
 const gate=new MaintenanceGate(),remove=gate.registerIdle(()=>false);assert.throws(()=>gate.acquire(),MaintenanceBusyError);gate.activity()();remove();
 const failure=new Error('probe'),detach=gate.registerIdle(()=>{throw failure;});assert.throws(()=>gate.acquire(),e=>e===failure);detach();gate.acquire()();
});
test('maintenance rejects start without consuming idempotency; preparing, printing, paused and stop cleanup reject maintenance',async()=>{
 const gate=new MaintenanceGate(),preparing=deferred(),stopping=deferred(),controller=printer(gate,{prepare:()=>preparing.promise,stop:()=>stopping.promise});
 const maintenance=gate.acquire();await assert.rejects(controller.start(request),MaintenanceBusyError);assert.equal(controller.state,'idle');maintenance();
 const started=controller.start(request);assert.throws(()=>gate.acquire(),MaintenanceBusyError);preparing.resolve();await started;assert.throws(()=>gate.acquire(),MaintenanceBusyError);
 await controller.pause();assert.throws(()=>gate.acquire(),MaintenanceBusyError);const cancelled=controller.cancel();assert.throws(()=>gate.acquire(),MaintenanceBusyError);stopping.resolve();await cancelled;gate.acquire()();
});
test('database maintenance holds admission across asynchronous idle check and worker settlement, releases errors, fences restored generation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'maintenance-gate-'));const store=await DatabaseStore.open({path:join(dir,'active.db'),backupDirectory:join(dir,'backups')});
 const gate=new MaintenanceGate(),controller=printer(gate),registry=new EndpointRegistry(new JsonRpcDispatcher()),entered=deferred(),idle=deferred();let check:()=>Promise<void>=()=>{entered.resolve();return idle.promise;};
 registerDatabaseMaintenance(registry,store,()=>check(),()=>{},gate);
 const context:RpcContext={transport:'http',signal:new AbortController().signal,authorize:()=>{},afterResponse:()=>{}};
 try{
  await store.insert('ui','value',1);const saving=registry.invoke('/server/database/backup','POST',{filename:'one.db'},context);await entered.promise;
  await assert.rejects(controller.start(request),MaintenanceBusyError);await assert.rejects(registry.invoke('/server/database/compact','POST',{},context),e=>e instanceof ApiError&&e.status===409);
  idle.resolve();await saving;gate.activity()();
  check=async()=>{throw new Error('idle check failed');};await assert.rejects(registry.invoke('/server/database/compact','POST',{},context),/idle check failed/);gate.activity()();
  check=async()=>{};await assert.rejects(registry.invoke('/server/database/restore','POST',{filename:'missing.db'},context));assert.equal(gate.status.closed,false);gate.activity()();
  await registry.invoke('/server/database/restore','POST',{filename:'one.db'},context);assert.equal(gate.status.closed,true);await assert.rejects(controller.start(request),MaintenanceBusyError);
 }finally{await store.close();await rm(dir,{recursive:true,force:true});}
});
test('journal restoration blocks maintenance until metadata is known and unregisters failed restoration',async()=>{
 const {PrintJournal}=await import('../src/operations/print-journal.ts');const dir=await mkdtemp(join(tmpdir(),'gate-journal-')),journal=await PrintJournal.open({path:join(dir,'jobs.sqlite'),deviceId:'printer1'});
 const gate=new MaintenanceGate(),reading=deferred(),entered=deferred(),original=journal.active.bind(journal),noop=async()=>{},device={prepare:noop,start:noop,pause:noop,resume:noop,finish:noop,stop:noop};
 journal.active=async()=>{entered.resolve();await reading.promise;return original();};
 try{const restoring=PrintController.restore(device,{maxNozzle:280,maxBed:110},{},{journal,maintenanceGate:gate});await entered.promise;assert.throws(()=>gate.acquire(),MaintenanceBusyError);reading.resolve();await restoring;gate.acquire()();}finally{await journal.close();await rm(dir,{recursive:true,force:true});}
 const badJournal={active:async()=>{throw new Error('read failed');}} as unknown as import('../src/operations/print-journal.ts').PrintJournal,other=new MaintenanceGate();await assert.rejects(PrintController.restore(device,{maxNozzle:280,maxBed:110},{},{journal:badJournal,maintenanceGate:other}),/read failed/);assert.equal(other.status.owners,0);other.acquire()();
});
test('client cancellation does not release an accepted database maintenance operation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'gate-cancel-')),store=await DatabaseStore.open({path:join(dir,'active.db'),backupDirectory:dir}),gate=new MaintenanceGate(),registry=new EndpointRegistry(new JsonRpcDispatcher()),entered=deferred(),settled=deferred(),abort=new AbortController();const original=store.backup.bind(store);
 store.backup=async name=>{const result=await original(name);entered.resolve();await settled.promise;return result;};registerDatabaseMaintenance(registry,store,()=>{},undefined,gate);
 try{const operation=registry.invoke('/server/database/backup','POST',{filename:'snapshot.db'},{transport:'http',signal:abort.signal,authorize:()=>{}});const rejected=assert.rejects(operation,/aborted/);await entered.promise;abort.abort();assert.throws(()=>gate.activity(),MaintenanceBusyError);settled.resolve();await rejected;gate.activity()();}finally{settled.resolve();await store.close();await rm(dir,{recursive:true,force:true});}
});
