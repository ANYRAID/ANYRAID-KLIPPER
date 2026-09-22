import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm,readFile} from 'node:fs/promises';
import {statfsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {NativePrintUploads} from '../src/moonraker/native-print-uploads.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
const dir=await mkdtemp(join(process.env.UPLOAD_BENCH_ROOT??tmpdir(),'upload-bench-')),gate=new MaintenanceGate(),files=await PublishedPrintFiles.open(join(dir,'files')),uploads=new NativePrintUploads(files,gate,{stagingRoot:dir}),rpc=new JsonRpcDispatcher();
const network=new MoonrakerNetwork(rpc,{nativeUploads:uploads,authorize:()=>{}}),signal=new AbortController().signal,results:unknown[]=[];
try{
 const address=await network.listen(),url=`http://127.0.0.1:${address.port}/server/files/upload`;
 for(const size of [4,16].map(n=>n*1024**2)){
  const data=Buffer.alloc(size,59),sha256=createHash('sha256').update(data).digest('hex'),sourcePath=join(dir,'source');await writeFile(sourcePath,data);const source=await open(sourcePath,'r');
  const times={direct:[] as number[],http:[] as number[]},delays={direct:[] as number[],http:[] as number[]};
  try{for(let run=0;run<9;run++)for(const mode of (run%2?['http','direct']:['direct','http']) as ('direct'|'http')[]){
   const id=`${mode}-${run}`,form=new FormData();form.append('file',new Blob([data]),'bench.gcode');form.append('file_id',id);
   const delay=monitorEventLoopDelay({resolution:1});delay.enable();await new Promise(r=>setTimeout(r,5));delay.reset();const start=performance.now();
   const record=mode==='direct'?await files.publish(id,'bench.gcode',source,signal):await (async()=>{const response=await fetch(url,{method:'POST',body:form});assert.equal(response.status,200);return (await response.json()).result.file;})();
   const elapsed=performance.now()-start;delay.disable();if(run>=2){times[mode].push(elapsed);delays[mode].push(delay.max/1e6);}
   assert.equal(record.sha256,sha256);assert.equal(record.size,size);assert.deepEqual(await readFile(join(dir,'files',sha256+'.gcode')),data);await files.remove(id,signal);
  }}finally{await source.close();}
  const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[3],p95Ms:values[6]};};
  results.push({size,results:Object.fromEntries((['direct','http'] as const).map(mode=>[mode,{...stats(times[mode]),medianMiBPerSecond:size/1024**2/(times[mode][3]/1000),eventLoopMaximumMs:Math.max(...delays[mode])}]))});
 }
 console.log(JSON.stringify({node:process.version,filesystemMagic:statfsSync(dir).type,warmups:2,runs:7,results,scope:'Direct immutable publication vs multipart HTTP loopback admission plus publication; same native store, authorization is noop. Input/FormData preparation, verification and deletion outside timing. HTTP client shares event loop; maximum delays include client work. No Python, target flash, concurrent motion or physical printer comparison.'},null,2));
}finally{await network.close();await uploads.close();await files.close();await rm(dir,{recursive:true,force:true});}
