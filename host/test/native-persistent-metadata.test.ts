import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm,mkdir,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {NativePrintUploads} from '../src/moonraker/native-print-uploads.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {ApiError,type Json,type RpcContext} from '../src/moonraker/rpc.ts';
test('persistent native assembly restores original URL without extraction and retires deleted or republished receipts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-persistent-')),signal=new AbortController().signal,context:RpcContext={signal,transport:'http',authorize(){}};
 let files=await PublishedPrintFiles.open(join(dir,'files')),owner=await NativePrintUploads.open(files,new MaintenanceGate(),{metadataRoot:join(dir,'metadata')});
 const scans=()=>{const status=owner.status.metadata;assert('scans' in status);return status.scans;};
 const missing=(error:unknown)=>error instanceof ApiError&&error.status===404;
 try{
  const png=await sharp({create:{width:32,height:32,channels:3,background:'#3a6'}}).png().toBuffer(),data=png.toString('base64');
  await writeFile(join(dir,'source'),`; thumbnail_png begin 32x32 ${data.length}\n; ${data}\n; thumbnail_png end\nG1 X1\n`);
  const publish=async()=>{const source=await open(join(dir,'source'),'r');try{await files.publish('part','part.gcode',source,signal);}finally{await source.close();}};
  await publish();const fields=await owner.metadata({filename:'part.gcode'},signal),thumbs=fields.thumbnails as Record<string,Json>[],path='/server/files/gcodes/'+thumbs.at(-1)!.relative_path;
  const handle=await owner.resolveThumbnail(path,context);assert.deepEqual((await handle.read()).bytes,png);
  await owner.close();await assert.rejects(handle.read());await files.close();
  files=await PublishedPrintFiles.open(join(dir,'files'));owner=await NativePrintUploads.open(files,new MaintenanceGate(),{metadataRoot:join(dir,'metadata')});
  assert(owner.hasThumbnail(path));assert.equal(scans(),0);
  let auth=0;await assert.rejects(owner.resolveThumbnail(path,{...context,authorize(_method,params){auth++;if(params.filename)throw new ApiError(403,'Denied');}}),error=>error instanceof ApiError&&error.status===403);assert.equal(auth,2);assert.equal(scans(),0);
  assert.deepEqual((await (await owner.resolveThumbnail(path,context)).read()).bytes,png);assert.equal(scans(),0);assert.deepEqual(await owner.metadata({filename:'part.gcode'},signal),fields);
  // Simulate an offline delete/republication with identical bytes and name.
  await owner.close();await files.remove('part',signal);await publish();
  owner=await NativePrintUploads.open(files,new MaintenanceGate(),{metadataRoot:join(dir,'metadata')});
  await assert.rejects(owner.resolveThumbnail(path,context),missing);const replacement=await owner.metadata({filename:'part.gcode'},signal),next='/server/files/gcodes/'+(replacement.thumbnails as Record<string,Json>[]).at(-1)!.relative_path;assert.notEqual(next,path);assert.equal(scans(),1);
  await owner.close();await files.remove('part',signal);
  owner=await NativePrintUploads.open(files,new MaintenanceGate(),{metadataRoot:join(dir,'metadata')});assert.equal(owner.hasThumbnail(next),false);await assert.rejects(owner.resolveThumbnail(next,context),missing);await assert.rejects(owner.metadata({filename:'part.gcode'},signal),missing);
  assert.equal(owner.status.metadata.imageBytes,0);
 }finally{await owner.close();await files.close();await rm(dir,{recursive:true,force:true});}
});
test('persistent assembly rejects public directories and releases startup locks for retry',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-persistent-root-')),files=await PublishedPrintFiles.open(join(dir,'files'));
 try{await mkdir(join(dir,'metadata'));await chmod(join(dir,'metadata'),0o755);await assert.rejects(NativePrintUploads.open(files,new MaintenanceGate(),{metadataRoot:join(dir,'metadata')}),/private/);await chmod(join(dir,'metadata'),0o700);const owner=await NativePrintUploads.open(files,new MaintenanceGate(),{metadataRoot:join(dir,'metadata')});await owner.close();assert.equal(files.status.closed,false);}finally{await files.close();await rm(dir,{recursive:true,force:true});}
});
test('nested native previews keep their original URLs and source ID after reopening the file and metadata stores',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-nested-persistent-')),signal=new AbortController().signal,context:RpcContext={signal,transport:'http',authorize(){}},filename='零件/50% test.gcode';
 let files=await PublishedPrintFiles.open(join(dir,'files')),owner=await NativePrintUploads.open(files,new MaintenanceGate(),{metadataRoot:join(dir,'metadata')});
 try{
  await files.mutateDirectory('零件',false,signal);const png=await sharp({create:{width:32,height:32,channels:3,background:'#3a6'}}).png().toBuffer(),data=png.toString('base64');await writeFile(join(dir,'source'),`; thumbnail_png begin 32x32 ${data.length}\n; ${data}\n; thumbnail_png end\nG1 X1\n`);
  const source=await open(join(dir,'source'),'r');try{await files.publish('part','50% test.gcode',source,signal,filename);}finally{await source.close();}
  const fields=await owner.metadata({filename},signal),thumbs=await owner.thumbnails({filename},signal),path='/server/files/gcodes/'+String((thumbs.at(-1) as Record<string,Json>).thumbnail_path).split('/').map(encodeURIComponent).join('/');assert.equal(fields.file_id,'part');assert.equal(owner.filename('part'),filename);
  assert.deepEqual((await (await owner.resolveThumbnail(path,context)).read()).bytes,png);await owner.close();await files.close();
  files=await PublishedPrintFiles.open(join(dir,'files'));owner=await NativePrintUploads.open(files,new MaintenanceGate(),{metadataRoot:join(dir,'metadata')});assert(owner.hasThumbnail(path));assert.deepEqual((await (await owner.resolveThumbnail(path,context)).read()).bytes,png);assert.deepEqual(await owner.metadata({filename},signal),fields);
  assert('scans' in owner.status.metadata);assert.equal(owner.status.metadata.scans,0);assert.equal(owner.filename('part'),filename);await assert.rejects(owner.resolveThumbnail('/server/files/gcodes/'+String((fields.thumbnails as Record<string,Json>[]).at(-1)!.relative_path),context),error=>error instanceof ApiError&&error.status===404);
 }finally{await owner.close();await files.close();await rm(dir,{recursive:true,force:true});}
});
