import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
const directory=await mkdtemp(join(tmpdir(),'gcode-file-bench-')),path=join(directory,'print.gcode');
const data=Array.from({length:100000},(_,i)=>`G1 X${i%250} Y${(i*7)%250} E${(i*.01).toFixed(2)} F12000\n`).join(''),digest=createHash('sha256').update(data).digest('hex');
const python=String.raw`
import sys,time,json,hashlib
def run():
 partial='';position=0;count=0;digest=hashlib.sha256()
 with open(sys.argv[1],encoding='utf-8') as f:
  while True:
   data=f.read(8192)
   if not data:break
   digest.update(data.encode());lines=data.split('\n');lines[0]=partial+lines[0];partial=lines.pop()
   for line in lines:position+=len(line.encode())+1;count+=1
 assert not partial
 return {'position':position,'lines':count,'digest':digest.hexdigest()}
result=run();times=[]
for i in range(13):
 start=time.perf_counter();run();elapsed=(time.perf_counter()-start)*1000
 if i>=2:times.append(elapsed)
print(json.dumps({'result':result,'times':sorted(times)}))
`;
try{
 await writeFile(path,data);const result=spawnSync('/usr/bin/python3',['-c',python,path],{encoding:'utf8',timeout:60000});if(result.status!==0)throw new Error(result.stderr);const oracle=JSON.parse(result.stdout);
 assert.deepEqual(oracle.result,{position:Buffer.byteLength(data),lines:100000,digest});const times:number[][]=[[],[]];
 for(let run=0;run<13;run++)for(const variant of run%2?[1,0]:[0,1]){
  const file=await open(path,'r'),reader=await GCodeFileReader.adopt(file,{chunkBytes:variant?65536:8192}),hash=createHash('sha256');let lines=0;const signal=new AbortController().signal,start=performance.now();
  try{while(true){const batch=await reader.next(signal);if(!batch)break;hash.update(batch.script+'\n');lines+=batch.lines;reader.commit(batch);}assert.equal(reader.status.position,Buffer.byteLength(data));assert.equal(reader.status.eof,true);assert.equal(lines,100000);assert.equal(hash.digest('hex'),digest);}finally{await reader.close();}
  const elapsed=performance.now()-start;if(run>=2)times[variant].push(elapsed);
 }
 const stats=(a:number[])=>{a.sort((x,y)=>x-y);return {medianMs:a[5],p95Ms:a[10]};};
 console.log(JSON.stringify({node:process.version,lines:100000,bytes:Buffer.byteLength(data),digestExact:true,python8192:stats(oracle.times),node8192:stats(times[0]),node65536:stats(times[1]),scope:'Python virtual_sdcard-style read/split/UTF-8 byte position loop, not full Python dispatch; Node additionally validates metadata and bounded batch acknowledgement. Warm filesystem, no motion or print-speed claim.'},null,2));
}finally{await rm(directory,{recursive:true,force:true});}
