import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,open,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import sharp from 'sharp';
import type {ThumbnailImage} from '../src/moonraker/thumbnail-images.ts';
import {pathToFileURL} from 'node:url';
import {externalAcceptanceBundle,assertAcceptanceBundleUnchanged} from '../test/helpers/acceptance-bundle.ts';
const retained=await externalAcceptanceBundle();
const {ThumbnailProcessor}=retained?await import(pathToFileURL(join(retained.path,'host/src/moonraker/thumbnail-process.js')).href) as typeof import('../src/moonraker/thumbnail-process.ts'):await import('../src/moonraker/thumbnail-process.ts');
const {prepareThumbnailImages}=retained?await import(pathToFileURL(join(retained.path,'host/src/moonraker/thumbnail-images.js')).href) as typeof import('../src/moonraker/thumbnail-images.ts'):await import('../src/moonraker/thumbnail-images.ts');
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const fingerprint=(images:ThumbnailImage[])=>images.map(image=>({width:image.width,height:image.height,format:image.format,miniature:image.miniature,sha256:sha(image.bytes)}));
const stats=(samples:number[])=>{assert(samples.length);const sorted=[...samples].sort((a,b)=>a-b);return {samples,medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.ceil(sorted.length*.95)-1]};};
let seed=42;const pixels=Buffer.alloc(768*512*3);for(let i=0;i<pixels.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;pixels[i]=seed>>>24;}
const png=await sharp(pixels,{raw:{width:768,height:512,channels:3}}).png().toBuffer(),base64=png.toString('base64');
const text=`; thumbnail begin 768x512 ${base64.length}\n; ${base64}\n; thumbnail end\n`;
const expected=fingerprint(await prepareThumbnailImages(text,new AbortController().signal));
const directory=await mkdtemp(join(tmpdir(),'ufp-thumbnail-bench-')),path=join(directory,'read-buffer');await writeFile(path,Buffer.alloc(64*1024,71));
const file=await open(path,'r');
const results:Array<{order:number;mode:'inline'|'png';startupMs:number;processing:ReturnType<typeof stats>;read64KiB:ReturnType<typeof stats>;eventLoop:{p99Ms:number;maxMs:number}}>=[];
try{
 for(const [index,mode] of (['inline','png','png','inline'] as const).entries()){
  const begin=performance.now(),processor=await ThumbnailProcessor.open(),startupMs=performance.now()-begin;
  const samples:number[]=[],reads:number[]=[],buffer=Buffer.alloc(64*1024),loop=monitorEventLoopDelay({resolution:1});let stopped=false;
  const io=(async()=>{while(!stopped){const before=performance.now(),result=await file.read(buffer,0,buffer.length,0);reads.push(performance.now()-before);assert.equal(result.bytesRead,buffer.length);await delay(1);}})();
  loop.enable();
  try{
   for(let i=0;i<19;i++){const before=performance.now(),signal=new AbortController().signal,images=mode==='inline'?await processor.prepare(text,signal):await processor.preparePng(png,signal);if(i>=3)samples.push(performance.now()-before);assert.deepEqual(fingerprint(images),expected);}
  }finally{stopped=true;await io;loop.disable();await processor.close();}
  results.push({order:index+1,mode,startupMs,processing:stats(samples),read64KiB:stats(reads),eventLoop:{p99Ms:loop.percentile(99)/1e6,maxMs:loop.max/1e6}});
 }
 const combined=['inline','png'].map(mode=>({mode,processing:stats(results.filter(result=>result.mode===mode).flatMap(result=>result.processing.samples))}));
 console.log(JSON.stringify({node:process.version,sharp:sharp.versions,bundle:retained??null,input:{width:768,height:512,pngBytes:png.length,pngSha256:sha(png),textBytes:Buffer.byteLength(text)},output:expected,warmupsPerRun:3,measuredPerRun:16,results,combined,scope:'Component ABBA; a supplied pinned bundle uses actual emitted JS and child. Same isolated child and exact image hashes; concurrent warm positioned 64 KiB reads. Includes IPC and parent verification in event-loop observations. Not complete UFP upload, durable thumbnail recovery, target board, Python equivalence or print speed.'},null,2));
}finally{await file.close();await rm(directory,{recursive:true,force:true});if(retained)await assertAcceptanceBundleUnchanged(retained);}
