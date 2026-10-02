import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import sharp from 'sharp';
import {ThumbnailStorage} from '../src/moonraker/thumbnail-storage.ts';
import type {ThumbnailImage} from '../src/moonraker/thumbnail-images.ts';
const signal=()=>new AbortController().signal,stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[5],p95Ms:v[10]};};
const directory=await mkdtemp(join(tmpdir(),'thumbnail-store-bench-'));let storage:ThumbnailStorage|undefined;
try{
 const raw=Buffer.alloc(768*512*3);let seed=42;for(let i=0;i<raw.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;raw[i]=seed>>>24;}
 const large=await sharp(raw,{raw:{width:768,height:512,channels:3}}).png().toBuffer(),small=await sharp(large).resize(32,32,{fit:'fill'}).png().toBuffer();
 const images:ThumbnailImage[]=[{width:32,height:32,format:'png',miniature:true,bytes:small},{width:768,height:512,format:'png',miniature:false,bytes:large}];
 storage=await ThumbnailStorage.open(join(directory,'store'));const publishes:number[]=[],deletes:number[]=[];const delay=monitorEventLoopDelay({resolution:1});delay.enable();
 for(let i=0;i<16;i++){const id=ThumbnailStorage.newId(),begin=performance.now();await storage.publish(id,images,signal());if(i>=5)publishes.push(performance.now()-begin);const removed=performance.now();await storage.remove(id,signal());if(i>=5)deletes.push(performance.now()-removed);}
 const id=ThumbnailStorage.newId();await storage.publish(id,images,signal());let begin=performance.now();await storage.inspect(id,signal());const coldVerifiedReadMs=performance.now()-begin;
 const smallPath=join(directory,'small.png'),largePath=join(directory,'large.png');await writeFile(smallPath,small);await writeFile(largePath,large);const variants=[];
 for(const [index,bytes,path,calls] of [[0,small,smallPath,1000],[1,large,largePath,50]] as const){const cached:number[]=[],files:number[]=[];for(let i=0;i<16;i++){begin=performance.now();for(let n=0;n<calls;n++){const result=await storage.read(id,index,signal());assert.equal(result.bytes.length,bytes.length);}if(i>=5)cached.push(performance.now()-begin);begin=performance.now();for(let n=0;n<calls;n++)assert.equal((await readFile(path)).length,bytes.length);if(i>=5)files.push(performance.now()-begin);}assert.deepEqual((await storage.read(id,index,signal())).bytes,bytes);variants.push({index,bytes:bytes.length,callsPerSample:calls,cached:stats(cached),plainNodeFileReadReference:stats(files)});}
 delay.disable();console.log(JSON.stringify({node:process.version,warmups:5,runs:11,imageBytes:small.length+large.length,publishWithFsync:stats(publishes),removeWithFsync:stats(deletes),firstVerifiedReadMs:coldVerifiedReadMs,variants,parentEventLoop:{p95Ms:delay.percentile(95)/1e6,maxMs:delay.max/1e6},cacheBytes:storage.status.cacheBytes,scope:'Immutable bundle publish includes sealed staging, hashing, blob/receipt fsync; each publish starts with empty storage. Cached binary copies versus plain Node warm-file reads, not Python/Moonraker HTTP or equal durability guarantees. No image decode, network or actual print timing.'},null,2));
}finally{await storage?.close();await rm(directory,{recursive:true,force:true});}
