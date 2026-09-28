import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {encodeFrame} from '../src/protocol/codec.ts';
export async function measureDump(executable:string,args:string[]){
 const start=performance.now(),child=spawn(executable,args,{stdio:['ignore','pipe','pipe']}),hash=createHash('sha256');let errors='',bytes=0;
 child.stdout.on('data',chunk=>{hash.update(chunk);bytes+=chunk.length;});child.stderr.on('data',chunk=>errors+=chunk);
 const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
 try{await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>code===0?resolve():reject(Error(`Dump failed: ${code}/${signal}: ${errors}`)));});assert.equal(errors,'');return {ms:performance.now()-start,sha256:hash.digest('hex'),bytes};}finally{clearTimeout(timer);}
}
export async function dumpFixture(dir:string){
 const dictionary=join(dir,'firmware.dict'),capture=join(dir,'capture.serial'),count=100000,frame=Buffer.from(encodeFrame(0,Uint8Array.from([2,4,32,8,127])));
 await writeFile(dictionary,JSON.stringify({commands:{'queue_step oid=%c interval=%u count=%hu add=%hi':2},responses:{}}));await writeFile(capture,Buffer.concat(Array.from({length:count},()=>frame)));
 return {dictionary,capture,count,bytes:count*frame.length};
}
export async function benchmarkDump(){
 const dir=await mkdtemp('/tmp/serial-dump-bench-');try{const f=await dumpFixture(dir),script=fileURLToPath(new URL('../../scripts/parsedump.ts',import.meta.url)),samples=[];
 const expected=createHash('sha256').update('queue_step oid=4 interval=32 count=8 add=-1\n'.repeat(f.count)).digest('hex');
 for(let i=0;i<6;i++){const result=await measureDump(process.execPath,[script,f.dictionary,f.capture]);assert.equal(result.sha256,expected);if(i)samples.push(result.ms);}
 const medianMs=[...samples].sort((a,b)=>a-b)[2];return {node:process.version,frames:f.count,inputBytes:f.bytes,samplesMs:samples,medianMs,framesPerSecond:f.count/(medianMs/1000),outputSha256:expected,scope:'Offline CLI subprocess including startup, file read, formatting and stdout hash; warm local filesystem. Not a printing hot path.'};
 }finally{await rm(dir,{recursive:true,force:true});}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const result=await benchmarkDump();process.stdout.write(JSON.stringify(result,null,2)+'\n');}
