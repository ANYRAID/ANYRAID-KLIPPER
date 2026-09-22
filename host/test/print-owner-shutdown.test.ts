import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PrintController} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate,MaintenanceBusyError} from '../src/operations/maintenance-gate.ts';
import {ProductPrintApi} from '../src/moonraker/product-print-api.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
const request={version:1 as const,requestId:'job',fileId:'file',nozzle:0,bed:0};
test('closing an idle native API fences retained controller references and releases observers',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'idle-owner-close-')),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'}),gate=new MaintenanceGate(),calls:string[]=[];
 const noop=async()=>{},controller=new PrintController({prepare:async()=>{calls.push('prepare');},start:async()=>{calls.push('start');},pause:noop,resume:noop,finish:noop,stop:noop},{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate}),api=new ProductPrintApi(controller,gate);
 try{
  const stream=api.watchState(new AbortController().signal);await stream.next();const waiting=stream.next();
  const closed=api.close();assert.equal(gate.status.closed,true);assert.throws(()=>gate.activity(),MaintenanceBusyError);await closed;
  assert.equal((await waiting).done,true);assert.equal(controller.stateObservers,0);
  await assert.rejects(controller.start(request),MaintenanceBusyError);assert.equal(await journal.get('job'),null);assert.deepEqual(calls,[]);
  assert.throws(()=>gate.registerIdle(()=>true),MaintenanceBusyError);assert.throws(()=>api.watchState(new AbortController().signal),/closed/);
 }finally{await api.close();await journal.close();await rm(dir,{recursive:true,force:true});}
});
test('a failed native close stays fenced through stop retry and local terminal reset',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'failed-owner-close-')),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'}),gate=new MaintenanceGate();let fail=true,starts=0;
 const noop=async()=>{},controller=new PrintController({prepare:noop,start:async()=>{starts++;},pause:noop,resume:noop,finish:noop,stop:async()=>{if(fail)throw new Error('stop unavailable');}},{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate}),api=new ProductPrintApi(controller,gate);
 try{
  await controller.start(request);await assert.rejects(api.close(),/stop unavailable/);assert.equal(gate.status.closed,true);
  fail=false;await api.close();controller.reset('job');assert.equal(controller.state,'idle');
  await assert.rejects(controller.start({...request,requestId:'late'}),MaintenanceBusyError);assert.equal(await journal.get('late'),null);assert.equal(starts,1);
 }finally{fail=false;await api.close();await journal.close();await rm(dir,{recursive:true,force:true});}
});
test('configured shutdown invalidates its gate before awaiting legacy or native cleanup',async()=>{
 for(const native of [false,true]){
  const dir=await mkdtemp(join(tmpdir(),'server-owner-close-')),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'}),gate=new MaintenanceGate();
  const noop=async()=>{},controller=new PrintController({prepare:noop,start:noop,pause:noop,resume:noop,finish:noop,stop:noop},{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate});let service:ConfiguredMoonraker|undefined;
  try{
   const path=join(dir,'main.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');service=await ConfiguredMoonraker.load(path,{maintenanceGate:gate,...native?{productPrint:controller}:{},information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize:()=>{}});await service.start();
   const release=gate.acquire(),closing=service.close();assert.equal(gate.status.closed,true);release();assert.throws(()=>gate.activity(),MaintenanceBusyError);await closing;
   await assert.rejects(controller.start(request),MaintenanceBusyError);assert.equal(await journal.get('job'),null);await assert.rejects(service.start(),/stopping/);
  }finally{await service?.close();await journal.close();await rm(dir,{recursive:true,force:true});}
 }
});
