import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createNativeProductHostFactory} from '../src/runtime/native-product-machine.ts';
import {runProductHost,type ProductHostFactory,type ProductHostProfile} from '../src/runtime/product-host.ts';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {productMachineFixture} from './helpers/product-machine.ts';
import {productHostFixture} from './helpers/product-host-profile.ts';
test('product host keeps one process file lock through reinitialization and releases it on final exit',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'process-file-host-')),abort=new AbortController(),control=new ProductHostControl(),ready=Promise.withResolvers<string>();
 const fixtures:Awaited<ReturnType<typeof productMachineFixture>>[]=[],profiles:ProductHostProfile[]=[];let current=await productMachineFixture(dir),calls=0,processClosed=0;fixtures.push(current);
 const filesRoot=join(dir,'files'),native=createNativeProductHostFactory(current.path,{filesRoot,metadataRoot:join(dir,'metadata'),createAdapter:async()=>{
  const f=current;return {stops:f.bindings.stops,output:f.bindings.print.output,lifecycle:f.bindings.print.lifecycle,async authorizePrintFile(){},server:{information:f.bindings.server.information,authorize(){},authorizeNotification(){}},release:()=>f.close()};
 }});
 const factory:ProductHostFactory=async signal=>{
  if(calls++){await assert.rejects(PublishedPrintFiles.open(filesRoot),/Lock published file directory/);current=await productMachineFixture(dir);fixtures.push(current);}
  const profile=await native(signal);profiles.push(profile);return profile;
 };
 factory.close=async()=>{processClosed++;await native.close!();};
 const addresses:string[]=[];const running=runProductHost(factory,abort.signal,address=>{const url=`http://127.0.0.1:${address.port}`;addresses.push(url);ready.resolve(url);},control);void running.catch(ready.reject);
 try{
  const first=await ready.promise,form=new FormData();form.append('file',new Blob(['G1 X1\n']),'persist.gcode');form.append('file_id','retained');
  const uploaded=await fetch(first+'/server/files/upload',{method:'POST',body:form});assert.equal(uploaded.status,201);assert.equal((await uploaded.json() as any).result.file.id,'retained');
  await assert.rejects(native(abort.signal),/not retired/);assert.equal(processClosed,0);
  const begin=performance.now();await control.reinitialize();t.diagnostic(JSON.stringify({simulatedReinitializeMs:performance.now()-begin}));
  assert.equal(addresses.length,2);assert.equal(processClosed,0);assert(profiles[0].product.maintenanceGate.status.closed);assert(fixtures[0].transport.stops.every(n=>n===1));
  const listing=await fetch(addresses[1]+'/server/files/list');assert.equal(listing.status,200);assert.equal((await listing.json() as any).result[0].file_id,'retained');
  const downloaded=await fetch(addresses[1]+'/server/files/gcodes/retained.gcode');assert.equal(downloaded.status,200);assert.equal(await downloaded.text(),'G1 X1\n');
  await assert.rejects(profiles[0].options.print.open('retained',abort.signal),/closed/);
  abort.abort();await running;assert.equal(processClosed,1);assert(fixtures.every(f=>f.transport.stops.every(n=>n===1)));
  const reopened=await PublishedPrintFiles.open(filesRoot);await reopened.close();await assert.rejects(native(new AbortController().signal),/closed/);
 }finally{abort.abort();await running.catch(()=>{});for(const p of profiles)await p.release();await native.close!();for(const f of fixtures)await f.close();await rm(dir,{recursive:true,force:true});}
});
test('failed generation assembly and cancelled late adapter cannot leak process file locks',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'process-file-failed-')),f=await productMachineFixture(dir),entered=Promise.withResolvers<void>(),held=Promise.withResolvers<void>();let released=0;
 const factory=createNativeProductHostFactory(f.path,{filesRoot:join(dir,'files'),metadataRoot:join(dir,'metadata'),createAdapter:async()=>{entered.resolve();await held.promise;return {stops:f.bindings.stops,output:f.bindings.print.output,lifecycle:f.bindings.print.lifecycle,async authorizePrintFile(){},server:{information:f.bindings.server.information,authorize(){},authorizeNotification(){}},async release(){released++;}};}});
 const opening=factory(new AbortController().signal),rejected=assert.rejects(opening,/closed/);
 try{
  await entered.promise;const closing=factory.close!();assert.equal(factory.close!(),closing);held.resolve();await rejected;await closing;assert.equal(released,1);
  const files=await PublishedPrintFiles.open(join(dir,'files'));await files.close();
 }finally{held.resolve();await opening.catch(()=>{});await factory.close!();await f.close();await rm(dir,{recursive:true,force:true});}
});
test('invalid preflight does not acquire process files or an adapter',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'process-file-preflight-'));let adapters=0;
 const factory=createNativeProductHostFactory(join(dir,'machine.json'),{filesRoot:join(dir,'files'),metadataRoot:join(dir,'metadata'),createAdapter:async()=>{adapters++;throw new Error('Unexpected adapter');}});
 try{
  await writeFile(join(dir,'machine.json'),'{}');await assert.rejects(factory(new AbortController().signal));assert.equal(adapters,0);await assert.rejects(access(join(dir,'files')));await factory.close!();
  const files=await PublishedPrintFiles.open(join(dir,'files'));assert.equal(files.status.publishedFiles,0);await files.close();
 }finally{await factory.close!();await rm(dir,{recursive:true,force:true});}
});
test('host closes process resources after startup failure and preserves their cleanup error',async()=>{
 let closed=0;
 const factory:ProductHostFactory=async()=>{throw new Error('profile startup failed');};factory.close=async()=>{closed++;throw new Error('process cleanup failed');};
 await assert.rejects(runProductHost(factory,new AbortController().signal,()=>{}),(error:unknown)=>error instanceof AggregateError&&error.errors.some(e=>String(e).includes('profile startup failed'))&&error.errors.some(e=>String(e).includes('process cleanup failed')));assert.equal(closed,1);
});
test('failed generation retirement still closes process owner exactly once after profile release',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'process-file-stop-failed-')),f=await productHostFixture(dir),abort=new AbortController(),control=new ProductHostControl(),ready=Promise.withResolvers<void>();let closed=0,released=false;
 const original=f.profile.release;f.profile.release=async()=>{await original();released=true;throw new Error('retirement failed');};
 const factory:ProductHostFactory=async()=>f.profile;factory.close=async()=>{assert(released);closed++;};
 const running=runProductHost(factory,abort.signal,()=>ready.resolve(),control);void running.catch(ready.reject);
 try{await ready.promise;const failed=assert.rejects(running,/retirement failed/);await assert.rejects(control.reinitialize(),/reinitialization failed/);await failed;assert.equal(closed,1);}finally{abort.abort();await running.catch(()=>{});await original();await rm(dir,{recursive:true,force:true});}
});
