import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {gzipSync} from 'node:zlib';
import {MotanLogReader} from '../src/motan/log-reader.ts';
const dir=await mkdtemp(join(tmpdir(),'motan-reader-bench-')),results:unknown[]=[];
try{for(const [label,count,rows] of [['small',30000,1],['bulk',128,1024]] as const){const path=join(dir,'log'),records=Array.from({length:count},(_,id)=>JSON.stringify({id,params:{data:Array.from({length:rows},(_,i)=>[id+i/rows,Math.sin(id+i),Math.cos(id-i)])}})),raw=Buffer.from(records.join('\x03')+'\x03');await writeFile(path,gzipSync(raw));const expected=count*(count-1)/2;const modes:Record<string,unknown>={},stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[3],p95Ms:values[6]};};
 for(const batch of [1,256]){const times:number[]=[],delays:number[]=[];for(let run=0;run<9;run++){const monitor=monitorEventLoopDelay({resolution:1});monitor.enable();await new Promise(r=>setTimeout(r,5));monitor.reset();const start=performance.now(),reader=await MotanLogReader.open(path);let received=0,total=0;try{for(;;){const messages=await reader.pullMessages(batch);if(!messages.length)break;for(const message of messages){received++;total+=message.id as number;}}}finally{await reader.close();}const elapsed=performance.now()-start;monitor.disable();if(run>=2){times.push(elapsed);delays.push(monitor.max/1e6);}assert.equal(received,count);assert.equal(total,expected);}modes['nodeBatch'+batch]={...stats(times),eventLoopMaximumMs:Math.max(...delays)};}
 results.push({label,count,rawBytes:raw.length,gzipBytes:(await readFile(path)).length,results:modes});
 }console.log(JSON.stringify({node:process.version,zlib:process.versions.zlib,warmups:2,runs:7,results,scope:'Node streaming reader over fixed generated local gzip workloads. Historical Python comparison is recorded in motan-python-entrypoint-retirement.json; no Python process is invoked. Includes decompression, exact JSON numeric boundary checks, message iteration and open/close; input construction excluded. Node strict EOF validation is additional. No target-board or concurrent-print proof.'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
