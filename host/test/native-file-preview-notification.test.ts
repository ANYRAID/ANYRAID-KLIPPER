import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,open,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {NativePrintUploads} from '../src/moonraker/native-print-uploads.ts';
import {NativePersistentMetadata} from '../src/moonraker/native-persistent-metadata.ts';
import {thumbnailPath} from '../src/moonraker/file-metadata.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {PrintController} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import type {Json,RpcContext} from '../src/moonraker/rpc.ts';

for(const [delegated,directory] of [[false,false],[true,false],[false,true],[true,true]])test(`${delegated?'device delegate':'offline owner'}, ${directory?'directory':'file'}: a rename notification publishes metadata whose preview survives completion of the same mutation`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-preview-notification-')),signal=new AbortController().signal,context:RpcContext={signal,transport:'http',authorize(){}};
 const files=await PublishedPrintFiles.open(join(dir,'files')),gate=new MaintenanceGate(),owner=await NativePrintUploads.open(files,gate,{metadataRoot:join(dir,'metadata')});
 let delegate:NativePrintUploads|undefined,journal:PrintJournal|undefined,controller:PrintController|undefined;
 if(delegated){journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'});controller=new PrintController({async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){}},{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate});delegate=new NativePrintUploads(files,gate,{},owner);delegate.bindPrintController(controller);owner.bindDeviceFiles(delegate,signal);}
 else{owner.bindOfflineFileMutations({available:true,beginFileMutations(){return ()=>{};}});owner.bindOfflineReadiness(()=>true);}
 const sourceName=directory?'原目录/原图 50%.gcode':'原图 50%.gcode',destination=directory?'页面 目录50%/原图 50%.gcode':'页面 验收50%.gcode',entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),original=NativePersistentMetadata.prototype.invalidate;
 let read:Promise<Record<string,Json>>|undefined,unsubscribe=()=>{};
 try{
  const png=await sharp({create:{width:32,height:32,channels:3,background:'#3a6'}}).png().toBuffer(),data=png.toString('base64');
  await writeFile(join(dir,'source'),`; thumbnail_png begin 32x32 ${data.length}\n; ${data}\n; thumbnail_png end\nG1 X1\n`);
  if(directory)await files.mutateDirectory('原目录',false,signal);
  const source=await open(join(dir,'source'),'r');try{await files.publish('part','原图 50%.gcode',source,signal,sourceName);}finally{await source.close();}
  const pathFor=(filename:string,fields:Record<string,Json>)=>'/server/files/gcodes/'+thumbnailPath(filename,String((fields.thumbnails as Record<string,Json>[])[0].relative_path)).split('/').map(encodeURIComponent).join('/');
  const before=await owner.metadata({filename:sourceName},signal),oldPath=pathFor(sourceName,before);assert.deepEqual((await (await owner.resolveThumbnail(oldPath,context)).read()).bytes,png);
  NativePersistentMetadata.prototype.invalidate=async function(filename){if(filename===sourceName){entered.resolve();await release.promise;}return original.call(this,filename);};
  unsubscribe=owner.observeChanges(event=>{const change=event as Record<string,Json>;if(change.action===(directory?'move_dir':'move_file')){read=owner.metadata({filename:destination},signal);void read.catch(()=>{});}});
  const moving=owner.move({source:'gcodes/'+(directory?'原目录':sourceName),dest:'gcodes/'+(directory?'页面 目录50%':destination)},context);void moving.catch(()=>{});
  await entered.promise;await new Promise<void>(resolve=>setImmediate(resolve));release.resolve();await moving;
  await new Promise<void>(resolve=>setImmediate(resolve));assert(read,'The committed move must still announce its file');
  const metadata=await read,path=pathFor(destination,metadata);
  assert.equal(metadata.file_id,'part');assert.equal(metadata.filename,destination);assert.notEqual(path,oldPath);
  const preview=await owner.resolveThumbnail(path,context);assert.deepEqual((await preview.read()).bytes,png);
  assert.deepEqual(await owner.metadata({filename:destination},signal),metadata,'A notification must not advertise a preview that needs another scan');
  await assert.rejects(owner.resolveThumbnail(oldPath,context));
 }finally{release.resolve();NativePersistentMetadata.prototype.invalidate=original;unsubscribe();await delegate?.close();await controller?.retire();await journal?.close();await owner.close();await files.close();await rm(dir,{recursive:true,force:true});}
});

test('unsubscribing suppresses a pending committed announcement without delaying storage or other observers',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-preview-unsubscribe-')),signal=new AbortController().signal,context:RpcContext={signal,transport:'http',authorize(){}},files=await PublishedPrintFiles.open(join(dir,'files')),owner=await NativePrintUploads.open(files,new MaintenanceGate(),{metadataRoot:join(dir,'metadata')});
 owner.bindOfflineFileMutations({available:true,beginFileMutations(){return ()=>{};}});owner.bindOfflineReadiness(()=>true);
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),original=NativePersistentMetadata.prototype.invalidate;
 let notified=0,retained=0,unsubscribe=()=>{},other=()=>{};
 try{
  await writeFile(join(dir,'source'),'G1 X1\n');const source=await open(join(dir,'source'),'r');try{await files.publish('part','part.gcode',source,signal,'part.gcode');}finally{await source.close();}
  NativePersistentMetadata.prototype.invalidate=async function(filename){if(filename==='part.gcode'){entered.resolve();await release.promise;}return original.call(this,filename);};
  unsubscribe=owner.observeChanges(()=>{notified++;});other=owner.observeChanges(()=>{retained++;});
  const moving=owner.move({source:'gcodes/part.gcode',dest:'gcodes/next.gcode'},context);void moving.catch(()=>{});await entered.promise;
  assert.equal(await files.resolvePath('next.gcode',signal),'part');unsubscribe();release.resolve();await moving;await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(notified,0);assert.equal(retained,1);
 }finally{release.resolve();NativePersistentMetadata.prototype.invalidate=original;unsubscribe();other();await owner.close();await files.close();await rm(dir,{recursive:true,force:true});}
});

test('held copy authorization cannot delay another committed file announcement',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-preview-authorizer-')),signal=new AbortController().signal,files=await PublishedPrintFiles.open(join(dir,'files')),owner=await NativePrintUploads.open(files,new MaintenanceGate(),{metadataRoot:join(dir,'metadata')});
 owner.bindOfflineFileMutations({available:true,beginFileMutations(){return ()=>{};}});owner.bindOfflineReadiness(()=>true);
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),events:Json[]=[];let unsubscribe=()=>{},copy:Promise<Json>|undefined;
 try{
  await writeFile(join(dir,'source'),'G1 X1\n');const source=await open(join(dir,'source'),'r');
  try{
   await files.publish('part','part.gcode',source,signal,'part.gcode');unsubscribe=owner.observeChanges(event=>events.push(event));
   copy=owner.copy({source:'gcodes/part.gcode',dest:'gcodes/copy.gcode'},{signal,transport:'http',async authorize(){entered.resolve();await release.promise;}});void copy.catch(()=>{});await entered.promise;
   await files.publish('other','other.gcode',source,signal,'other.gcode');assert.equal(events.length,1);assert.equal((events[0] as Record<string,Json>).action,'create_file');
  }finally{await source.close();}
  release.resolve();await copy;await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(events.length,2);
 }finally{release.resolve();await copy?.catch(()=>{});unsubscribe();await owner.close();await files.close();await rm(dir,{recursive:true,force:true});}
});
