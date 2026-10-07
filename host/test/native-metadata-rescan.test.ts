import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import sharp from 'sharp';
import {WebSocket} from 'ws';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {NativeFileMetadata} from '../src/moonraker/native-file-metadata.ts';
import {NativePersistentMetadata} from '../src/moonraker/native-persistent-metadata.ts';
import {NativePrintUploads,registerNativeFileInfo} from '../src/moonraker/native-print-uploads.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {ApiError,JsonRpcDispatcher,type Json,type RpcContext} from '../src/moonraker/rpc.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
const signal=new AbortController().signal,context:RpcContext={signal,transport:'http',authorize(){}};
const missing=(error:unknown)=>error instanceof ApiError&&error.status===404;
const pathOf=(fields:Record<string,Json>)=>'/server/files/gcodes/'+(fields.thumbnails as Record<string,Json>[]).at(-1)!.relative_path;
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'native-rescan-')),files=await PublishedPrintFiles.open(join(dir,'files'));
 try{
  const png=await sharp({create:{width:32,height:32,channels:3,background:'#3a6'}}).png().toBuffer(),data=png.toString('base64');
  const model=`; thumbnail_png begin 32x32 ${data.length}\n; ${data}\n; thumbnail_png end\nG1 X1.23456789\n`;
  await writeFile(join(dir,'source'),model);const fd=await open(join(dir,'source'),'r');try{await files.publish('part','part.gcode',fd,signal);}finally{await fd.close();}
  return {dir,files,png,close:async()=>{await files.close();await rm(dir,{recursive:true,force:true});}};
 }catch(error){await files.close();await rm(dir,{recursive:true,force:true});throw error;}
}
for(const persistent of [false,true])test(`native ${persistent?'persistent':'memory'} forced scan bypasses cache and revokes old thumbnail handles`,async()=>{
 const f=await fixture();let owner=persistent?await NativePersistentMetadata.open(join(f.dir,'metadata'),f.files):new NativeFileMetadata(f.files);
 try{
  const before=await owner.metadata('part.gcode',signal),old=pathOf(before),handle=await owner.resolveThumbnail(old,context);
  assert.deepEqual(await owner.metadata('part.gcode',signal),before);
  const after=await owner.rescan('part.gcode',signal),next=pathOf(after);assert.notEqual(next,old);
  assert.deepEqual({...after,thumbnails:[]},{...before,thumbnails:[]});assert.equal(owner.hasThumbnail(old),false);
  await assert.rejects(handle.read(),missing);await assert.rejects(owner.resolveThumbnail(old,context),missing);
  assert.deepEqual((await (await owner.resolveThumbnail(next,context)).read()).bytes,f.png);
  if(persistent){assert('scans' in owner.status);assert.equal(owner.status.scans,2);await owner.close();owner=await NativePersistentMetadata.open(join(f.dir,'metadata'),f.files);assert(owner.hasThumbnail(next));assert.equal(owner.hasThumbnail(old),false);assert.deepEqual(await owner.metadata('part.gcode',signal),after);assert('scans' in owner.status);assert.equal(owner.status.scans,0);assert.equal(owner.status.recovered,1);}
  const cancelled=new AbortController();cancelled.abort(new ApiError(499,'Cancelled before scan'));
  await assert.rejects(owner.rescan('part.gcode',cancelled.signal),error=>error instanceof ApiError&&error.status===499);
  assert.deepEqual(await owner.metadata('part.gcode',signal),after);
  await assert.rejects(owner.rescan('absent.gcode',signal),missing);
 }finally{await owner.close();await f.close();}
});
for(const persistent of [false,true])test(`native ${persistent?'persistent':'memory'} rescan serializes earlier readers and rejects overflow without hidden work`,async()=>{
 const f=await fixture(),owner=persistent?await NativePersistentMetadata.open(join(f.dir,'metadata'),f.files):new NativeFileMetadata(f.files);
 const original=f.files.describeSource.bind(f.files),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let held=false;
 f.files.describeSource=async(...args)=>{if(!held){held=true;entered.resolve();await release.promise;}return original(...args);};
 try{
  const earlier=owner.metadata('part.gcode',signal);await entered.promise;
  const forced=owner.rescan('part.gcode',signal);
  const later=persistent?owner.metadata('part.gcode',signal):undefined;
  const other=persistent?owner.metadata('part.gcode',signal):undefined;
  await assert.rejects(owner.metadata('part.gcode',signal),error=>error instanceof ApiError&&error.status===503);
  release.resolve();const old=await earlier,next=await forced;assert.notEqual(pathOf(old),pathOf(next));
  if(later)assert.deepEqual(await later,next);if(other)assert.deepEqual(await other,next);
  assert.deepEqual(await owner.metadata('part.gcode',signal),next);await assert.rejects(owner.resolveThumbnail(pathOf(old),context),missing);
  if(persistent){assert('scans' in owner.status);assert.equal(owner.status.scans,2);}
  assert.equal(owner.status.pending,0);assert.equal(owner.status.snapshots.reservations,0);
 }finally{release.resolve();await owner.close();await f.close();}
});
for(const persistent of [false,true])test(`native ${persistent?'persistent':'memory'} forced scan cannot publish a deleted source`,async()=>{
 const f=await fixture(),owner=persistent?await NativePersistentMetadata.open(join(f.dir,'metadata'),f.files):new NativeFileMetadata(f.files);
 const original=f.files.acquireBinary.bind(f.files),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 try{
  const before=await owner.metadata('part.gcode',signal);
  f.files.acquireBinary=async(...args)=>{entered.resolve();await release.promise;return original(...args);};
  const forced=owner.rescan('part.gcode',signal);await entered.promise;await f.files.remove('part',signal);release.resolve();
  await assert.rejects(forced);assert.equal(owner.hasThumbnail(pathOf(before)),false);await assert.rejects(owner.metadata('part.gcode',signal),missing);
  assert.equal(owner.status.pending,0);assert.equal(owner.status.snapshots.reservations,0);
 }finally{release.resolve();await owner.close();await f.close();}
});
for(const persistent of [false,true])test(`native ${persistent?'persistent':'memory'} readers queued behind a cancelled rescan recover a fresh consistent preview`,async()=>{
 const f=await fixture(),owner=persistent?await NativePersistentMetadata.open(join(f.dir,'metadata'),f.files):new NativeFileMetadata(f.files),cancelled=new AbortController();
 const original=f.files.acquireBinary.bind(f.files),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let held=false;
 try{
  const before=await owner.metadata('part.gcode',signal);
  f.files.acquireBinary=async(...args)=>{if(!held){held=true;entered.resolve();await release.promise;}return original(...args);};
  const forced=owner.rescan('part.gcode',cancelled.signal),rejected=assert.rejects(forced);
  await entered.promise;const later=owner.metadata('part.gcode',signal);cancelled.abort(new ApiError(499,'Cancelled during scan'));release.resolve();await rejected;
  const after=await later;assert.notEqual(pathOf(after),pathOf(before));await assert.rejects(owner.resolveThumbnail(pathOf(before),context),missing);
  assert.deepEqual((await (await owner.resolveThumbnail(pathOf(after),context)).read()).bytes,f.png);assert.equal(owner.status.pending,0);assert.equal(owner.status.snapshots.reservations,0);
 }finally{release.resolve();await owner.close();await f.close();}
});
test('memory reads admitted during a forced scan share only its new preview',async()=>{
 const f=await fixture(),owner=new NativeFileMetadata(f.files),original=f.files.acquireBinary.bind(f.files),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 try{
  const before=await owner.metadata('part.gcode',signal);f.files.acquireBinary=async(...args)=>{entered.resolve();await release.promise;return original(...args);};
  const forced=owner.rescan('part.gcode',signal);await entered.promise;const later=owner.metadata('part.gcode',signal);release.resolve();const after=await forced;assert.notEqual(pathOf(before),pathOf(after));assert.deepEqual(await later,after);
 }finally{release.resolve();await owner.close();await f.close();}
});
test('native metascan HTTP and WebSocket share force semantics and authorize before scanning',async()=>{
 const f=await fixture(),owner=await NativePrintUploads.open(f.files,new MaintenanceGate(),{metadataRoot:join(f.dir,'metadata')}),rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc),remove=registerNativeFileInfo(registry,owner),seen:string[]=[];
 const service=new MoonrakerNetwork(rpc,{endpoints:registry,authorize(method,_params,c){seen.push(method);if(c.request.headers['x-api-key']!=='key')throw new ApiError(401,'Unauthorized');if(c.request.headers['x-deny']==='yes')throw new ApiError(403,'Denied');}});
 let ws:WebSocket|undefined;
 try{
  const address=await service.listen(),url=`http://127.0.0.1:${address.port}`,headers={'x-api-key':'key'},scans=()=>{assert('scans' in owner.status.metadata);return owner.status.metadata.scans;};
  const initial=await owner.metadata({filename:'part.gcode'},signal);assert.equal(scans(),1);
  let response=await fetch(url+'/server/files/metascan?filename=part.gcode',{method:'POST'});assert.equal(response.status,401);await response.arrayBuffer();assert.equal(scans(),1);
  response=await fetch(url+'/server/files/metascan?filename=part.gcode',{method:'POST',headers:{...headers,'x-deny':'yes'}});assert.equal(response.status,403);await response.arrayBuffer();assert.equal(scans(),1);
  response=await fetch(url+'/server/files/metascan?filename=part.gcode',{headers});assert.equal(response.status,405);await response.arrayBuffer();assert.equal(scans(),1);
  for(const args of ['','?filename=part.gcode&extra=1','?filename=../part.gcode']){response=await fetch(url+'/server/files/metascan'+args,{method:'POST',headers});assert.equal(response.status,400);await response.arrayBuffer();}assert.equal(scans(),1);
  response=await fetch(url+'/server/files/metascan?filename=absent.gcode',{method:'POST',headers});assert.equal(response.status,404);await response.arrayBuffer();assert.equal(scans(),1);
  response=await fetch(url+'/server/files/metascan?filename=part.gcode',{method:'POST',headers});assert.equal(response.status,200);const next=(await response.json() as {result:Record<string,Json>}).result;assert.notEqual(pathOf(next),pathOf(initial));assert.equal(scans(),2);
  ws=new WebSocket(url.replace('http:','ws:')+'/websocket',{headers});await once(ws,'open');const result=once(ws,'message');ws.send(JSON.stringify({jsonrpc:'2.0',method:'server.files.metascan',params:{filename:'part.gcode'},id:7}));const parsed=JSON.parse(String((await result)[0]));assert.equal(parsed.id,7);assert.notEqual(pathOf(parsed.result),pathOf(next));assert.equal(scans(),3);assert(seen.includes('server.files.metascan'));
  remove();assert.equal(rpc.has('server.files.metascan'),false);assert.equal(registry.allowed('/server/files/metascan'),undefined);
 }finally{ws?.terminate();await service.close();remove();await owner.close();await f.close();}
});
