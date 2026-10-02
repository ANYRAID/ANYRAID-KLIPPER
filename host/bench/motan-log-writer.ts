import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {gunzipSync} from 'node:zlib';
import {MotanLogWriter} from '../src/motan/log-writer.ts';
const dir=await mkdtemp(join(tmpdir(),'motan-bench-')),results:unknown[]=[];
try{for(const [label,count,rows,flushEvery] of [['small',4096,1,256],['bulk',128,1024,16]] as const){
 const records=Array.from({length:count},(_,i)=>Buffer.from(JSON.stringify({q:'stepq:stepper_x',params:{data:Array.from({length:rows},(_,j)=>[i+j/rows,Math.sin(i+j)*100,Math.cos(i-j)*100,i+j])}}))),raw=Buffer.concat(records.flatMap(r=>[r,Buffer.from([3])])),input=join(dir,'input'),output=join(dir,'output');await writeFile(input,raw);
 const stats=(n:number[])=>{n.sort((a,b)=>a-b);return {medianMs:n[3],p95Ms:n[6]};},modes:Record<string,unknown>={};
 for(const batch of [1,16]){const times:number[]=[],delays:number[]=[];for(let run=0;run<9;run++){const delay=monitorEventLoopDelay({resolution:1});delay.enable();await new Promise(r=>setTimeout(r,5));delay.reset();const start=performance.now(),writer=await MotanLogWriter.open(output);try{for(let i=0;i<records.length;i+=batch){await writer.addRecords(records.slice(i,i+batch));if((i+batch)%flushEvery===0)await writer.flush();}}finally{await writer.close();}const elapsed=performance.now()-start;delay.disable();if(run>=2){times.push(elapsed);delays.push(delay.max/1e6);}assert.deepEqual(gunzipSync(await readFile(output)),raw);await rm(output);}modes['nodeBatch'+batch]={...stats(times),eventLoopMaximumMs:Math.max(...delays)};}
 results.push({label,records:count,bytes:raw.length,flushEvery,results:modes});
 }console.log(JSON.stringify({node:process.version,zlib:process.versions.zlib,warmups:2,runs:7,results,scope:'Node async compression/file writes verified against exact ETX bytes and full-flush boundaries on local tmpfs. Original Python timings are historical in motan-io-python-baselines.json; no Python process is invoked. Includes open/close; excludes input generation, verification, socket capture and target-printer load. Node batch 16 may only group records without an intervening index boundary.'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
