import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,open,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createNativeProductBindings,NativeProductFileResources,type NativeMachineAdapter,type NativeProductMachineOptions} from '../src/runtime/native-product-machine.ts';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import type {ProductMachineConfiguration} from '../src/config/product-machine.ts';
const signal=()=>new AbortController().signal;
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'native-machine-'));let releases=0,authorized:string[]=[];
 const config:ProductMachineConfiguration={version:1,deviceId:'test',printerConfig:join(root,'printer.cfg'),moonrakerConfig:join(root,'moonraker.conf'),journalPath:join(root,'jobs.db'),mcus:{mcu:{transport:'uart',rts:true,leaveBootloader:false}},machine:{enableLeadTime:.001,fanMinimumScheduleTime:.001},print:{motorCompletion:'hold',startupHoming:{mode:'home',axes:[0,1,2]},parking:{parkXY:[0,0],retract:0,lift:0,travelSpeed:10,liftSpeed:10,retractSpeed:10}},limits:{maxNozzle:300,maxBed:130}};
 const adapter:NativeMachineAdapter={stops:new Map([['mcu',async()=>{}]]),lifecycle:{async prepare(){},async start(){},async finishOutputs(){},async stopOutputs(){}},output(){},async authorizePrintFile(id){authorized.push(id);if(id==='denied')throw new Error('File denied');},server:{information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize(){},authorizeNotification(){}},async release(){releases++;}};
 const options:NativeProductMachineOptions={filesRoot:join(root,'files'),metadataRoot:join(root,'metadata'),standardPrint:{nozzle:200,bed:60},createAdapter:async()=>adapter};
 return {root,config,adapter,options,authorized,get releases(){return releases;},async seed(visible?:string){const files=await PublishedPrintFiles.open(options.filesRoot),path=join(root,'source');await writeFile(path,'G1 X1\n');const file=await open(path,'r');try{if(visible)await files.mutateDirectory('零件',false,signal());await files.publish('job','part.gcode',file,signal(),visible);}finally{await file.close();await files.close();}},async close(){await rm(root,{recursive:true,force:true});}};
}
test('shared native ownership resolves canonical files, seals print bytes and preserves policy snapshots',async()=>{
 const f=await fixture();let bindings:Awaited<ReturnType<typeof createNativeProductBindings>>|undefined;
 try{await f.seed();const gate=new MaintenanceGate();bindings=await createNativeProductBindings(f.config,signal(),gate,f.options);f.options.standardPrint!.nozzle=290;(f.adapter.stops as Map<string,(cause:unknown)=>Promise<void>>).clear();
 assert.equal(bindings.stops.size,1);assert(bindings.server.nativeUploads!.usesGate(gate));assert.deepEqual(await bindings.server.productPrintCompatibility!.start('job.gcode',signal()),{fileId:'job',nozzle:200,bed:60});
 const reader=await bindings.print.open('job',signal());try{assert.equal((await reader.next(signal()))!.script,'G1 X1');}finally{await reader.close();}assert.deepEqual(f.authorized,['job','job']);
 await assert.rejects(bindings.print.open('denied',signal()),/File denied/);await assert.rejects(bindings.server.productPrintCompatibility!.start('../job.gcode',signal()),/Invalid native filename/);await assert.rejects(bindings.server.productPrintCompatibility!.start('missing.gcode',signal()),/Published file not found/);
 const a=bindings.release(),b=bindings.release();assert.equal(a,b);await a;assert.equal(f.releases,1);assert(bindings.server.nativeUploads!.status.closed);await assert.rejects(bindings.print.open('job',signal()),/closed/);const reopened=await PublishedPrintFiles.open(f.options.filesRoot);await reopened.close();
 }finally{await bindings?.release();await f.close();}
});
test('invalid temperatures and overlapping stores fail before adapter acquisition',async()=>{
 const f=await fixture();let calls=0;f.options.createAdapter=async()=>{calls++;return f.adapter;};try{
 for(const standardPrint of [{nozzle:301,bed:60},{nozzle:200,bed:NaN},{nozzle:-1,bed:60}])await assert.rejects(createNativeProductBindings(f.config,signal(),new MaintenanceGate(),{...f.options,standardPrint}),/temperatures/);
 await assert.rejects(createNativeProductBindings(f.config,signal(),new MaintenanceGate(),{...f.options,metadataRoot:join(f.options.filesRoot,'metadata')}),/separate/);assert.equal(calls,0);await assert.rejects(access(f.options.filesRoot));
 }finally{await f.close();}
});
test('standard print selection resolves a visible directory path to the authorized immutable receipt',async()=>{
 const f=await fixture();let bindings:Awaited<ReturnType<typeof createNativeProductBindings>>|undefined;
 try{
  await f.seed('零件/50% test.gcode');bindings=await createNativeProductBindings(f.config,signal(),new MaintenanceGate(),f.options);
  assert.deepEqual(await bindings.server.productPrintCompatibility!.start('零件/50% test.gcode',signal()),{fileId:'job',nozzle:200,bed:60});assert.deepEqual(f.authorized,['job']);assert.equal(bindings.server.nativeUploads!.filename('job'),'零件/50% test.gcode');
  await assert.rejects(bindings.server.productPrintCompatibility!.start('job.gcode',signal()),/Published file not found/);assert.deepEqual(f.authorized,['job'],'An internal ID is not a second visible path');
  const reader=await bindings.print.open('job',signal());try{assert.equal((await reader.next(signal()))!.script,'G1 X1');}finally{await reader.close();}
 }finally{await bindings?.release();await f.close();}
});
test('failed metadata startup closes the already opened store and releases the adapter',async()=>{
 const f=await fixture();try{await writeFile(f.options.metadataRoot,'not a directory');await assert.rejects(createNativeProductBindings(f.config,signal(),new MaintenanceGate(),f.options));assert.equal(f.releases,1);const reopened=await PublishedPrintFiles.open(f.options.filesRoot);await reopened.close();}finally{await f.close();}
});
test('late cancelled adapter return and invalid policy release acquired resources',async()=>{
 const f=await fixture();try{const abort=new AbortController();await assert.rejects(createNativeProductBindings(f.config,abort.signal,new MaintenanceGate(),{...f.options,createAdapter:async()=>{abort.abort(new Error('late cancellation'));return f.adapter;}}),/late cancellation/);assert.equal(f.releases,1);await assert.rejects(access(f.options.filesRoot));
 await assert.rejects(createNativeProductBindings(f.config,signal(),new MaintenanceGate(),{...f.options,createAdapter:async()=>({...f.adapter,authorizePrintFile:undefined} as unknown as NativeMachineAdapter)}),/Incomplete/);assert.equal(f.releases,2);
 }finally{await f.close();}
});
test('closing cancels delayed file admission and waits for its callback before adapter release',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),held=Promise.withResolvers<void>();let bindings:Awaited<ReturnType<typeof createNativeProductBindings>>|undefined;
 try{await f.seed();f.adapter.authorizePrintFile=async()=>{entered.resolve();await held.promise;};bindings=await createNativeProductBindings(f.config,signal(),new MaintenanceGate(),f.options);const opening=bindings.print.open('job',signal()),rejected=assert.rejects(opening,/closed/);await entered.promise;const closing=bindings.release();await Promise.resolve();assert.equal(f.releases,0);held.resolve();await rejected;await closing;assert.equal(f.releases,1);
 }finally{held.resolve();await bindings?.release();await f.close();}
});
test('adapter cleanup failure is reported after native stores release their locks',async()=>{
 const f=await fixture();try{f.adapter.release=async()=>{throw new Error('board release failed');};const bindings=await createNativeProductBindings(f.config,signal(),new MaintenanceGate(),f.options);await assert.rejects(bindings.release(),(error:unknown)=>error instanceof AggregateError&&error.errors.some(e=>String(e).includes('board release failed')));assert(bindings.server.nativeUploads!.status.closed);const reopened=await PublishedPrintFiles.open(f.options.filesRoot);await reopened.close();}finally{await f.close();}
});
test('file admission is bounded and a closed shared gate rejects late authorization',async()=>{
 const f=await fixture(),held=Promise.withResolvers<void>(),gate=new MaintenanceGate();let bindings:Awaited<ReturnType<typeof createNativeProductBindings>>|undefined;
 try{await f.seed();f.adapter.authorizePrintFile=async()=>held.promise;bindings=await createNativeProductBindings(f.config,signal(),gate,f.options);
 const jobs=Array.from({length:8},()=>bindings!.print.open('job',signal())),checks=jobs.map(job=>assert.rejects(job,/admission closed/));
 await assert.rejects(bindings.print.open('job',signal()),/capacity/);await Promise.resolve();gate.invalidate();held.resolve();await Promise.all(checks);
 }finally{held.resolve();await bindings?.release();await f.close();}
});
test('standard print remains opt-in and adapters cannot override native ownership',async()=>{
 const f=await fixture();let bindings:Awaited<ReturnType<typeof createNativeProductBindings>>|undefined;
 try{bindings=await createNativeProductBindings(f.config,signal(),new MaintenanceGate(),{...f.options,standardPrint:undefined});assert.equal(bindings.server.productPrintCompatibility,undefined);await bindings.release();
 const invalid={...f.adapter,server:{...f.adapter.server,productPrintCompatibility:{start:async()=>({fileId:'outside',nozzle:0,bed:0})}}};
 await assert.rejects(createNativeProductBindings(f.config,signal(),new MaintenanceGate(),{...f.options,createAdapter:async()=>invalid}),/owns file/);assert.equal(f.releases,2);
 }finally{await bindings?.release();await f.close();}
});
test('process files retain the actual lock and bytes across exclusive generation leases',async()=>{
 const f=await fixture();let resources:NativeProductFileResources|undefined,first:Awaited<ReturnType<typeof createNativeProductBindings>>|undefined,second:typeof first;
 try{
  await f.seed();resources=await NativeProductFileResources.open(f.options);
  const options={...f.options,files:undefined,fileResources:resources};first=await createNativeProductBindings(f.config,signal(),new MaintenanceGate(),options);
  assert(resources.status.leased);await assert.rejects(PublishedPrintFiles.open(f.options.filesRoot),/Lock published file directory/);
  await assert.rejects(createNativeProductBindings(f.config,signal(),new MaintenanceGate(),options),/not retired/);assert.equal(f.releases,0);
  await first.release();assert.equal(resources.status.leased,false);assert.equal(resources.status.files.closed,false);assert.equal(f.releases,1);
  await assert.rejects(PublishedPrintFiles.open(f.options.filesRoot),/Lock published file directory/);
  second=await createNativeProductBindings(f.config,signal(),new MaintenanceGate(),options);
  await assert.rejects(first.print.open('job',signal()),/closed/);
  assert.deepEqual(await second.server.productPrintCompatibility!.start('job.gcode',signal()),{fileId:'job',nozzle:200,bed:60});
  const reader=await second.print.open('job',signal());try{assert.equal((await reader.next(signal()))!.script,'G1 X1');}finally{await reader.close();}
  await second.release();await resources.close();assert.equal(resources.status.files.closed,true);assert.equal(f.releases,2);
  const reopened=await PublishedPrintFiles.open(f.options.filesRoot);await reopened.close();
 }finally{await first?.release();await second?.release();await resources?.close();await f.close();}
});
test('process close waits for ignored cancellation and adapter release before unlocking files',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),held=Promise.withResolvers<void>(),adapterEntered=Promise.withResolvers<void>(),adapterHeld=Promise.withResolvers<void>();let resources:NativeProductFileResources|undefined,bindings:Awaited<ReturnType<typeof createNativeProductBindings>>|undefined;
 try{
  await f.seed();resources=await NativeProductFileResources.open(f.options);f.adapter.authorizePrintFile=async()=>{entered.resolve();await held.promise;};f.adapter.release=async()=>{adapterEntered.resolve();await adapterHeld.promise;};
  bindings=await createNativeProductBindings(f.config,signal(),new MaintenanceGate(),{...f.options,fileResources:resources});
  const opening=bindings.print.open('job',signal()),rejected=assert.rejects(opening,/closed/);await entered.promise;
  const retiring=bindings.release(),closing=resources.close();assert.equal(resources.close(),closing);
  await Promise.resolve();assert(resources.status.leased);assert.equal(resources.status.files.closed,false);assert.throws(()=>resources!.acquire(f.options),/closed/);
  held.resolve();await rejected;await adapterEntered.promise;assert(resources.status.leased);await assert.rejects(PublishedPrintFiles.open(f.options.filesRoot),/Lock published file directory/);
  adapterHeld.resolve();await retiring;await closing;assert.equal(resources.status.files.closed,true);
 }finally{held.resolve();adapterHeld.resolve();await bindings?.release();await resources?.close();await f.close();}
});
test('failed generation metadata startup releases its lease without destroying process storage',async()=>{
 const f=await fixture();let resources:NativeProductFileResources|undefined,bindings:Awaited<ReturnType<typeof createNativeProductBindings>>|undefined;
 try{
  await f.seed();resources=await NativeProductFileResources.open(f.options);await writeFile(f.options.metadataRoot,'not a directory');
  await assert.rejects(createNativeProductBindings(f.config,signal(),new MaintenanceGate(),{...f.options,fileResources:resources}));
  assert.equal(f.releases,1);assert.equal(resources.status.leased,false);assert.equal(resources.status.files.closed,false);
  await rm(f.options.metadataRoot);bindings=await createNativeProductBindings(f.config,signal(),new MaintenanceGate(),{...f.options,fileResources:resources});
  assert.equal((await bindings.server.productPrintCompatibility!.start('job.gcode',signal())).fileId,'job');await bindings.release();
 }finally{await bindings?.release();await resources?.close();await f.close();}
});
test('process storage rejects identity changes and option overrides before adapter acquisition',async()=>{
 const f=await fixture();let resources:NativeProductFileResources|undefined,calls=0;
 try{
  resources=await NativeProductFileResources.open(f.options);f.options.createAdapter=async()=>{calls++;return f.adapter;};
  await assert.rejects(createNativeProductBindings(f.config,signal(),new MaintenanceGate(),{...f.options,fileResources:resources,files:{maxFileBytes:1}}),/override/);
  for(const roots of [{filesRoot:join(f.root,'other-files')},{metadataRoot:join(f.root,'other-metadata')}])await assert.rejects(createNativeProductBindings(f.config,signal(),new MaintenanceGate(),{...f.options,...roots,fileResources:resources}),/identity/);
  assert.equal(calls,0);assert.equal(resources.status.leased,false);
 }finally{await resources?.close();await f.close();}
});
test('adapter cleanup failure releases the lease but remains a failed generation outcome',async()=>{
 const f=await fixture();let resources:NativeProductFileResources|undefined;
 try{
  await f.seed();resources=await NativeProductFileResources.open(f.options);f.adapter.release=async()=>{throw new Error('adapter retirement failed');};
  const bindings=await createNativeProductBindings(f.config,signal(),new MaintenanceGate(),{...f.options,fileResources:resources});
  const failed=bindings.release();await assert.rejects(failed,(error:unknown)=>error instanceof AggregateError&&error.errors.some(e=>String(e).includes('adapter retirement failed')));assert.equal(bindings.release(),failed);
  assert.equal(resources.status.leased,false);assert.equal(resources.status.files.closed,false);assert(bindings.server.nativeUploads!.status.closed);
  await resources.close();const reopened=await PublishedPrintFiles.open(f.options.filesRoot);await reopened.close();
 }finally{await resources?.close();await f.close();}
});
