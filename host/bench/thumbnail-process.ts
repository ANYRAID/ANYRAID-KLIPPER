import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import sharp from 'sharp';
import qoi from 'qoijs';
import {prepareThumbnailImages,type ThumbnailImage} from '../src/moonraker/thumbnail-images.ts';
import {ThumbnailProcessor} from '../src/moonraker/thumbnail-process.ts';
const block=(bytes:Buffer,width:number,height:number,format:string)=>{const b64=bytes.toString('base64');return `; thumbnail_${format} begin ${width}x${height} ${b64.length}\n; ${b64}\n; thumbnail_${format} end\n`;};
const fingerprint=(images:ThumbnailImage[])=>images.map(image=>({width:image.width,height:image.height,format:image.format,miniature:image.miniature,sha256:createHash('sha256').update(image.bytes).digest('hex')}));
const stats=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {samples:sorted.length,medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.95)-1)]};};
let seed=42;const noise=Buffer.alloc(768*512*3);for(let i=0;i<noise.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;noise[i]=seed>>>24;}
const png=await sharp(noise,{raw:{width:768,height:512,channels:3}}).png().toBuffer(),rgba=Buffer.alloc(2048*1024*4);for(let i=0;i<rgba.length;i+=4){rgba[i]=255;rgba[i+3]=255;}
const qoiData=Buffer.from(qoi.encode(new Uint8Array(rgba.buffer,rgba.byteOffset,rgba.byteLength),{width:2048,height:1024,channels:4,colorspace:0}));
const variants=[{name:'PNG large IPC payload',text:block(png,768,512,'png')},{name:'QOI large decoded pixels',text:block(qoiData,2048,1024,'qoi')}];
const directory=await mkdtemp(join(tmpdir(),'thumbnail-process-bench-')),path=join(directory,'print-buffer');await writeFile(path,Buffer.alloc(64*1024,71));let processor:ThumbnailProcessor|undefined;
try{
 const startup=performance.now();processor=await ThumbnailProcessor.open({timeoutMs:10000});const startupMs=performance.now()-startup,results=[];
 for(const variant of variants){const expected=fingerprint(await prepareThumbnailImages(variant.text,new AbortController().signal)),modes=[];
  for(const mode of ['direct','process'] as const){const samples:number[]=[],ioSamples:number[]=[],loop=monitorEventLoopDelay({resolution:1});let stopped=false;
   const io=(async()=>{while(!stopped){const begin=performance.now();await readFile(path);ioSamples.push(performance.now()-begin);await delay(1);}})();loop.enable();await delay(5);
   try{for(let i=0;i<16;i++){const begin=performance.now(),images:ThumbnailImage[]=mode==='direct'?await prepareThumbnailImages(variant.text,new AbortController().signal):await processor.prepare(variant.text,new AbortController().signal);if(i>=5)samples.push(performance.now()-begin);assert.deepEqual(fingerprint(images),expected);}await delay(5);}
   finally{stopped=true;await io;loop.disable();}
   modes.push({mode,processing:stats(samples),parentFileRead64KiB:stats(ioSamples),eventLoop:{p95Ms:loop.percentile(95)/1e6,maxMs:loop.max/1e6}});
  }
  results.push({name:variant.name,inputBytes:Buffer.byteLength(variant.text),modes});
 }
 const processStatus=await readFile(`/proc/${processor.status.pid}/status`,'utf8'),memory=Object.fromEntries(processStatus.split('\n').filter(line=>/^Vm(HWM|RSS):/.test(line)).map(line=>line.split(':').map(v=>v.trim())));
 console.log(JSON.stringify({node:process.version,sharp:sharp.versions.sharp,startupMs,warmups:5,runs:11,results,childMemory:memory,scope:'Sequential direct-then-child Node image processing with exact buffer hashes; includes IPC. Warm 64 KiB parent file reads under load, event-loop delay includes verification. Startup separate. Not Python equivalence, target-board UART deadlines, cold disk, or physical print throughput.'},null,2));
}finally{await processor?.close();await rm(directory,{recursive:true,force:true});}
