import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {NativeFileMetadata} from '../src/moonraker/native-file-metadata.ts';
import {ApiError,type Json,type RpcContext} from '../src/moonraker/rpc.ts';
test('native preview entry and byte eviction revoke URLs while sources remain readable; close revokes existing handles',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'preview-bounds-')),files=await PublishedPrintFiles.open(join(dir,'files')),owner=new NativeFileMetadata(files),signal=new AbortController().signal,context:RpcContext={signal,transport:'http',authorize(){}};
 const missing=(error:unknown)=>error instanceof ApiError&&error.status===404;
 try{
  for(const width of [32,384]){
   let seed=42;const raw=Buffer.alloc(width*width*3);for(let i=0;i<raw.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;raw[i]=seed>>>24;}
   const png=await sharp(raw,{raw:{width,height:width,channels:3}}).png().toBuffer(),data=png.toString('base64'),sourcePath=join(dir,'source');
   await writeFile(sourcePath,`; thumbnail_png begin ${width}x${width} ${data.length}\n; ${data}\n; thumbnail_png end\n`);const source=await open(sourcePath,'r');let first='';
   try{for(let i=0;i<(width===32?129:40);i++){
    const id='p-'+width+'-'+i;await files.publish(id,'preview.gcode',source,signal);const fields=await owner.metadata(id+'.gcode',signal),thumbs=fields.thumbnails as Record<string,Json>[];
    if(i===0)first='/server/files/gcodes/'+thumbs.at(-1)!.relative_path;
    assert(owner.status.imageBundles<=128);assert(owner.status.imageBytes<=16*1024**2);assert(owner.status.cache.entries<=128);
   }}finally{await source.close();}
   assert.equal((await files.inspect('p-'+width+'-0')).name,'preview.gcode');await assert.rejects(owner.resolveThumbnail(first,context),missing);
   const rebuilt=await owner.metadata('p-'+width+'-0.gcode',signal),last=(rebuilt.thumbnails as Record<string,Json>[]).at(-1)!,path='/server/files/gcodes/'+last.relative_path;assert.notEqual(path,first);
   const handle=await owner.resolveThumbnail(path,context);assert.deepEqual((await handle.read()).bytes,png);
   if(width===384){await owner.close();await assert.rejects(handle.read());assert.equal(owner.status.imageBytes,0);assert.equal(owner.status.imageBundles,0);}
  }
 }finally{await owner.close();await files.close();await rm(dir,{recursive:true,force:true});}
});
