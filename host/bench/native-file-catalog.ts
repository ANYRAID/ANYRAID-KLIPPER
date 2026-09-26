import assert from 'node:assert/strict';
import type {Json} from '../src/moonraker/rpc.ts';
import {mkdtemp,open,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cpus} from 'node:os';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {NativePrintUploads} from '../src/moonraker/native-print-uploads.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
const dir=await mkdtemp(join(tmpdir(),'native-catalog-bench-')),signal=new AbortController().signal;
let files:PublishedPrintFiles|undefined,uploads:NativePrintUploads|undefined;
try{
 const sourcePath=join(dir,'source');await writeFile(sourcePath,'G1 X1.000001\n');const source=await open(sourcePath,'r');
 files=await PublishedPrintFiles.open(join(dir,'files'));uploads=new NativePrintUploads(files,new MaintenanceGate());
 try{for(let i=0;i<1024;i++)await files.publish(String(i).padStart(4,'0'),'模型.gcode',source,signal);}finally{await source.close();}
 const samples:number[][]=[[],[]];let bytes=0;
 for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
  const start=performance.now();
  if(mode===0){const ids=await files.listIds(signal);for(const id of ids)await files.inspect(id);}
  else{const result:Json=await uploads.list({},signal);assert(Array.isArray(result));assert.equal(result.length,1024);bytes=Buffer.byteLength(JSON.stringify(result));}
  const elapsed=performance.now()-start;if(run>=3)samples[mode].push(elapsed);
 }
 const stats=samples.map(values=>{values.sort((a,b)=>a-b);return {medianMs:values[5],p95Ms:values[10]};});
 console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,files:1024,warmup:3,runs:11,variants:['sequentialReceiptInspectionReference','nativeCatalogIncludingJsonSerialization'],stats,responseBytes:bytes,scope:'Local warm filesystem; reference is ID enumeration plus receipt inspection, not a previous Moonraker implementation. Excludes network, startup recovery, publication fsync and MCU work.'},null,2));assert(stats[1].p95Ms<50,'Catalog exceeds event-loop latency budget');
}finally{await uploads?.close();await files?.close();await rm(dir,{recursive:true,force:true});}
