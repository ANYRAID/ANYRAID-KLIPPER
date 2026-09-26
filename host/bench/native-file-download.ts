import assert from 'node:assert/strict';
import {mkdtemp,rm,open,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {createHash} from 'node:crypto';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {NativePrintUploads} from '../src/moonraker/native-print-uploads.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
const dir=await mkdtemp(join(tmpdir(),'native-download-bench-')),files=await PublishedPrintFiles.open(join(dir,'files')),uploads=new NativePrintUploads(files,new MaintenanceGate()),signal=new AbortController().signal,results:unknown[]=[];
try{
 for(const size of [2,16,64].map(mib=>mib*1024**2)){
  const data=Buffer.alloc(size,59),digest=createHash('sha256').update(data).digest('hex'),id=String(size),path=join(dir,'source');await writeFile(path,data);const source=await open(path,'r');try{await files.publish(id,'large.gcode',source,signal);}finally{await source.close();}
  const samples:number[][]=[[],[]],loop=monitorEventLoopDelay({resolution:1});loop.enable();let maxChunk=0;
  for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
   const start=performance.now();
   if(mode===0){const result=await files.readBytes(id,signal,64*1024**2);assert.equal(result.bytes.length,size);}
   else await uploads.download('/server/files/gcodes/'+id+'.gcode',{transport:'http',signal,authorize:()=>{}},async(file,signal)=>{let bytes=0;const hash=createHash('sha256');for await(const chunk of file.reader.chunks(signal)){maxChunk=Math.max(maxChunk,chunk.length);hash.update(chunk);bytes+=chunk.length;}assert.equal(bytes,size);assert.equal(hash.digest('hex'),digest);});
   if(run>=3)samples[mode].push(performance.now()-start);
  }
  loop.disable();assert.equal(uploads.status.downloadSnapshots.reservations,0);assert(maxChunk<=65536);
  results.push({bytes:size,stats:samples.map(values=>{values.sort((a,b)=>a-b);return {medianMs:values[5],p95Ms:values[10]};}),maxChunkBytes:maxChunk,eventLoop:{p99Ms:loop.percentile(99)/1e6,maxMs:loop.max/1e6}});
 }
 console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,warmups:3,runs:11,variants:['verifiedWholeBufferReference','sealedDownloadWithConsumerSha256'],results,scope:'Alternating warm local reads. Whole-buffer reference allocates the entire file; sealed download copies to quota-controlled memfd then streams 64 KiB chunks, including an extra consumer hash for validation. Excludes HTTP, target hardware and sustained load; aggregate event-loop values cover both variants.'},null,2));
}finally{await uploads.close();await files.close();await rm(dir,{recursive:true,force:true});}
