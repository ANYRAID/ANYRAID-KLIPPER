import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {createHash} from 'node:crypto';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import sharp from 'sharp';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {NativeFileMetadata} from '../src/moonraker/native-file-metadata.ts';
import type {Json,RpcContext} from '../src/moonraker/rpc.ts';
const dir=await mkdtemp(join(tmpdir(),'native-preview-bench-')),files=await PublishedPrintFiles.open(join(dir,'files')),owner=new NativeFileMetadata(files),signal=new AbortController().signal;
const context:RpcContext={signal,transport:'http',authorize(){}},results:unknown[]=[];
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[5],p95Ms:values[10]};};
try{
 for(const [size,width] of [[256*1024,64],[4*1024**2,384]]){
  let seed=42;const raw=Buffer.alloc(width*width*3);for(let i=0;i<raw.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;raw[i]=seed>>>24;}
  const png=await sharp(raw,{raw:{width,height:width,channels:3}}).png().toBuffer(),data=png.toString('base64'),header=`; thumbnail_png begin ${width}x${width} ${data.length}\n; ${data}\n; thumbnail_png end\n`,body=Buffer.alloc(size,59);assert(Buffer.byteLength(header)<1024**2);body.write(header);body[size-1]=10;
  const sourcePath=join(dir,'source');await writeFile(sourcePath,body);const source=await open(sourcePath,'r');try{for(let i=0;i<14;i++)await files.publish('p-'+width+'-'+i,'preview.gcode',source,signal);}finally{await source.close();}
  const loop=monitorEventLoopDelay({resolution:1});loop.enable();const cold:number[]=[],cached:number[]=[],read:number[]=[];
  for(let i=0;i<14;i++){
   const filename='p-'+width+'-'+i+'.gcode';let start=performance.now();const metadata=await owner.metadata(filename,signal),elapsed=performance.now()-start;
   const thumbnails=metadata.thumbnails as Record<string,Json>[];assert.equal(thumbnails.length,2);assert.equal(thumbnails[1].width,width);
   start=performance.now();assert.deepEqual(await owner.metadata(filename,signal),metadata);const hot=performance.now()-start;
   start=performance.now();const download=await owner.resolveThumbnail('/server/files/gcodes/'+thumbnails[1].relative_path,context),image=await download.read(),downloadMs=performance.now()-start;assert.deepEqual(image.bytes,png);assert.equal(image.sha256,createHash('sha256').update(png).digest('hex'));
   if(i>=3){cold.push(elapsed);cached.push(hot);read.push(downloadMs);}
  }
  loop.disable();assert.equal(owner.status.snapshots.reservations,0);const hot=stats(cached),download=stats(read);assert(hot.p95Ms!<50);assert(download.p95Ms!<50);
  results.push({fileBytes:size,imageWidth:width,imageBytes:png.length,inputSha256:createHash('sha256').update(body).digest('hex'),cold:stats(cold),cached:hot,read:download,eventLoop:{p99Ms:loop.percentile(99)/1e6,maxMs:loop.max/1e6},cacheImageBytes:owner.status.imageBytes});
 }
 console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,warmups:3,runs:11,results,scope:'Local sealed native files with deterministic noisy PNG, full file hash, Worker extraction, child image decoding and miniature generation. Cold startup excluded. Cached preview read includes receipt validation and independent byte copy. No HTTP, Python performance comparison or target hardware claim.'},null,2));
}finally{await owner.close();await files.close();await rm(dir,{recursive:true,force:true});}
