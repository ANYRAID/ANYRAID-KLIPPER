import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {NativePersistentMetadata} from '../src/moonraker/native-persistent-metadata.ts';
import {MetadataVersions} from '../src/moonraker/metadata-versions.ts';
import {ApiError,type Json} from '../src/moonraker/rpc.ts';
const signal=new AbortController().signal,missing=(error:unknown)=>error instanceof ApiError&&error.status===404;
const pathOf=(fields:Record<string,Json>)=>'/server/files/gcodes/'+(fields.thumbnails as Record<string,Json>[]).at(-1)!.relative_path;
async function bounded<T>(promise:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Independent cache read did not settle')),3000);})]);}finally{clearTimeout(timer);}}
async function fixture(warmB=true){
 const dir=await mkdtemp(join(tmpdir(),'native-cache-reads-')),files=await PublishedPrintFiles.open(join(dir,'files'));let owner:NativePersistentMetadata|undefined;
 const accepted:Promise<unknown>[]=[];const track=<T>(promise:Promise<T>)=>{accepted.push(promise);void promise.catch(()=>{});return promise;};
 try{
  const png=await sharp({create:{width:32,height:32,channels:3,background:'#3a6'}}).png().toBuffer(),data=png.toString('base64');
  await writeFile(join(dir,'source'),`; thumbnail_png begin 32x32 ${data.length}\n; ${data}\n; thumbnail_png end\nG1 X1.23456789\n`);
  const fd=await open(join(dir,'source'),'r');try{for(const name of ['a','b','c','d'])await files.publish(name,name+'.gcode',fd,signal);}finally{await fd.close();}
  owner=await NativePersistentMetadata.open(join(dir,'metadata'),files);const a=await owner.metadata('a.gcode',signal),b=warmB?await owner.metadata('b.gcode',signal):undefined;
  return {dir,files,owner,a,b,png,track,close:async()=>{await Promise.allSettled(accepted);await owner!.close();await files.close();await rm(dir,{recursive:true,force:true});}};
 }catch(error){await owner?.close();await files.close();await rm(dir,{recursive:true,force:true});throw error;}
}
function holdBinary(files:PublishedPrintFiles,id='a'){
 const original=files.acquireBinary.bind(files),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let held=false;
 files.acquireBinary=async(...args)=>{if(!held&&args[0]===id){held=true;entered.resolve();await release.promise;}return original(...args);};
 return {entered:entered.promise,release:()=>release.resolve()};
}
function holdSource(files:PublishedPrintFiles,id='b'){
 const original=files.describeSource.bind(files),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let held=false;
 files.describeSource=async(...args)=>{if(!held&&args[0]===id){held=true;entered.resolve();await release.promise;}return original(...args);};
 return {entered:entered.promise,release:()=>release.resolve()};
}
test('independent cached metadata and actual thumbnail reads bypass a held rescan',async()=>{
 const f=await fixture(),held=holdBinary(f.files);
 try{
  const forced=f.track(f.owner.rescan('a.gcode',signal));await held.entered;
  assert.deepEqual(await bounded(f.track(f.owner.metadata('b.gcode',signal))),f.b);
  const download=await bounded(f.owner.resolveThumbnail(pathOf(f.b!),{signal,transport:'http',authorize(){}}));assert.deepEqual((await bounded(download.read())).bytes,f.png);
  assert.equal(f.owner.status.pending,1);assert.equal(f.owner.status.scans,2);held.release();const next=await forced;assert.notEqual(pathOf(next),pathOf(f.a));assert.equal(f.owner.status.pending,0);
 }finally{held.release();await f.close();}
});
test('a cold request retains the original serial writer order',async()=>{
 const f=await fixture(false),held=holdBinary(f.files);let settled=false;
 try{const forced=f.track(f.owner.rescan('a.gcode',signal));await held.entered;const cold=f.track(f.owner.metadata('b.gcode',signal).then(value=>{settled=true;return value;}));await setImmediate();assert.equal(settled,false);assert.equal(f.owner.status.pending,2);held.release();await forced;const next=await cold;assert.equal(next.file_id,'b');assert.equal(f.owner.status.scans,3);}finally{held.release();await f.close();}
});
test('cached readers behind a forced scan of the same filename observe only its new generation',async()=>{
 const f=await fixture(),held=holdBinary(f.files);let settled=false;
 try{const forced=f.track(f.owner.rescan('a.gcode',signal));await held.entered;const later=f.track(f.owner.metadata('a.gcode',signal).then(value=>{settled=true;return value;}));await setImmediate();assert.equal(settled,false);held.release();const next=await forced;assert.deepEqual(await later,next);assert.notEqual(pathOf(next),pathOf(f.a));assert.equal(f.owner.hasThumbnail(pathOf(f.a)),false);}finally{held.release();await f.close();}
});
test('later writers wait for an earlier parallel cached source validation',async()=>{
 const f=await fixture(),held=holdSource(f.files);let acquired=false;
 const original=f.files.acquireBinary.bind(f.files);f.files.acquireBinary=async(...args)=>{if(args[0]==='b')acquired=true;return original(...args);};
 try{const earlier=f.track(f.owner.metadata('b.gcode',signal));await held.entered;const forced=f.track(f.owner.rescan('b.gcode',signal));await setImmediate();assert.equal(acquired,false);assert.equal(f.owner.status.pending,2);held.release();assert.deepEqual(await earlier,f.b);const next=await forced;assert.equal(acquired,true);assert.notEqual(pathOf(next),pathOf(f.b!));}finally{held.release();await f.close();}
});
test('invalidated parallel cache tickets fall back behind earlier work without deadlocking on themselves',async()=>{
 const f=await fixture(),binary=holdBinary(f.files),source=holdSource(f.files);let readerSettled=false;
 try{
  const forced=f.track(f.owner.rescan('a.gcode',signal));await binary.entered;
  const reader=f.track(f.owner.metadata('b.gcode',signal).then(value=>{readerSettled=true;return value;}));await source.entered;
  const invalidating=f.track(f.owner.invalidate('b.gcode'));source.release();await setImmediate();assert.equal(readerSettled,false);assert.equal(f.owner.status.pending,3);
  binary.release();await bounded(Promise.all([forced,reader,invalidating]));const next=await f.owner.metadata('b.gcode',signal);assert.notEqual(pathOf(next),pathOf(f.b!));assert.equal(f.owner.status.pending,0);assert.equal(f.owner.status.snapshots.reservations,0);
 }finally{source.release();binary.release();await f.close();}
});
test('parallel receipt validation does not return a removed file from cache',async()=>{
 const f=await fixture(),binary=holdBinary(f.files),source=holdSource(f.files);
 try{const forced=f.track(f.owner.rescan('a.gcode',signal));await binary.entered;const reader=f.track(f.owner.metadata('b.gcode',signal));await source.entered;await f.files.remove('b',signal);source.release();binary.release();await forced;await assert.rejects(bounded(reader),missing);await assert.rejects(f.owner.metadata('b.gcode',signal),missing);assert.equal(f.owner.status.pending,0);}finally{source.release();binary.release();await f.close();}
});
test('a replacement during parallel validation returns the new receipt and generation through the serial protocol',async()=>{
 const f=await fixture(),binary=holdBinary(f.files),source=holdSource(f.files);
 try{
  const forced=f.track(f.owner.rescan('a.gcode',signal));await binary.entered;const reader=f.track(f.owner.metadata('b.gcode',signal));await source.entered;
  const fd=await open(join(f.dir,'source'),'r');try{const plan=await f.files.prepareUploadReplacement('new-b','b.gcode','b.gcode',signal);await f.files.replaceUpload(plan,fd,signal);}finally{await fd.close();}
  source.release();binary.release();await forced;const next=await bounded(reader);assert.equal(next.file_id,'new-b');assert.notEqual(pathOf(next),pathOf(f.b!));assert.equal(f.owner.hasThumbnail(pathOf(f.b!)),false);
  assert.deepEqual((await (await f.owner.resolveThumbnail(pathOf(next),{signal,transport:'http',authorize(){}})).read()).bytes,f.png);assert.equal(f.owner.status.pending,0);
 }finally{source.release();binary.release();await f.close();}
});
test('parallel cancellation preserves the original reason and drains accepted validation',async()=>{
 const f=await fixture(),held=holdSource(f.files),cancelled=new AbortController(),reason=new ApiError(499,'Cancel cached read');
 try{const reader=f.track(f.owner.metadata('b.gcode',cancelled.signal));await held.entered;cancelled.abort(reason);assert.equal(f.owner.status.pending,1);held.release();await assert.rejects(reader,error=>error===reason);assert.deepEqual(await f.owner.metadata('b.gcode',signal),f.b);assert.equal(f.owner.status.pending,0);}finally{held.release();await f.close();}
});
test('close aborts and drains both an independent reader and a held writer',async()=>{
 const f=await fixture(),binary=holdBinary(f.files),source=holdSource(f.files);let closed=false;
 try{const forced=f.track(f.owner.rescan('a.gcode',signal));await binary.entered;const reader=f.track(f.owner.metadata('b.gcode',signal));await source.entered;const closing=f.owner.close().then(()=>{closed=true;});await setImmediate();assert.equal(closed,false);assert.equal(f.owner.status.closed,true);assert.equal(f.owner.status.pending,2);source.release();binary.release();await bounded(closing);await assert.rejects(forced);await assert.rejects(reader);assert.equal(f.owner.status.pending,0);await assert.rejects(f.owner.metadata('b.gcode',signal),error=>error instanceof ApiError&&error.status===503);}finally{source.release();binary.release();await f.close();}
});
test('parallel and serial requests share four admission slots; overflow performs no hidden work',async()=>{
 const f=await fixture(),binary=holdBinary(f.files),source=holdSource(f.files);let dCalls=0;
 const original=f.files.resolvePath.bind(f.files);f.files.resolvePath=async(...args)=>{if(args[0]==='d.gcode')dCalls++;return original(...args);};
 try{const forced=f.track(f.owner.rescan('a.gcode',signal));await binary.entered;const b=f.track(f.owner.metadata('b.gcode',signal));await source.entered;const later=f.track(f.owner.metadata('b.gcode',signal)),cold=f.track(f.owner.metadata('c.gcode',signal));assert.equal(f.owner.status.pending,4);await assert.rejects(f.owner.metadata('d.gcode',signal),error=>error instanceof ApiError&&error.status===503);assert.equal(dCalls,0);source.release();binary.release();await bounded(Promise.all([forced,b,later,cold]));assert.equal(f.owner.status.pending,0);assert.equal((await f.owner.metadata('d.gcode',signal)).file_id,'d');assert.equal(dCalls,1);}finally{source.release();binary.release();await f.close();}
});
test('a fault discovered during a parallel cache validation fences the cached response',async()=>{
 const f=await fixture(),held=holdSource(f.files),original=MetadataVersions.prototype.invalidate,error=new Error('Injected version failure');
 MetadataVersions.prototype.invalidate=()=>Promise.reject(error);
 try{const invalidating=f.track(f.owner.invalidate('a.gcode')),reader=f.track(f.owner.metadata('b.gcode',signal));await held.entered;await assert.rejects(invalidating,value=>value===error);assert.equal(f.owner.status.faulted,true);held.release();await assert.rejects(reader,value=>value instanceof ApiError&&value.status===503);await assert.rejects(f.owner.metadata('b.gcode',signal),value=>value instanceof ApiError&&value.status===503);}finally{MetadataVersions.prototype.invalidate=original;held.release();await f.close();}
});
test('completed cache admissions release copied responses while their owner remains open',()=>{
 const extension=import.meta.url.endsWith('.js')?'js':'ts',helper=fileURLToPath(new URL('./helpers/metadata-cache-retention.'+extension,import.meta.url));
 const result=spawnSync(process.execPath,['--expose-gc',helper],{encoding:'utf8',timeout:15000,maxBuffer:1024**2});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);
 assert.deepEqual(JSON.parse(result.stdout),{copies:64,gcRequests:8,liveResponseCopies:0,scope:'Response retention control; no process-wide leak claim'});
});
