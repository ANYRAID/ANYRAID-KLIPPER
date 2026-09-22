import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {gunzipSync} from 'node:zlib';
import {MotanLogWriter} from '../src/motan/log-writer.ts';
const dir=await mkdtemp(join(tmpdir(),'motan-bench-')),source=execFileSync('git',['show','1e18134f:scripts/motan/data_logger.py'],{encoding:'utf8'}),results:unknown[]=[];
assert.equal(createHash('sha256').update(source).digest('hex'),'0089711b4861c6a043de27b916edaa74d0dd2039b8f6738dc0a734a6746436a4');
const code=String.raw`import json,sys,ast,time,zlib
v=json.load(sys.stdin);tree=ast.parse(v['source']);tree.body=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='LogWriter'];ns={'zlib':zlib};exec(compile(tree,'original-motan-writer','exec'),ns)
records=open(v['records'],'rb').read().split(b'\x03')[:-1];times=[]
for run in range(9):
    start=time.perf_counter();w=ns['LogWriter'](v['output'])
    for i,record in enumerate(records):
        w.add_data(record)
        if (i+1)%v['flushEvery']==0:w.flush()
    w.close()
    if run>=2:times.append((time.perf_counter()-start)*1000)
print(json.dumps(times))`;
try{for(const [label,count,rows,flushEvery] of [['small',4096,1,256],['bulk',128,1024,16]] as const){
 const records=Array.from({length:count},(_,i)=>Buffer.from(JSON.stringify({q:'stepq:stepper_x',params:{data:Array.from({length:rows},(_,j)=>[i+j/rows,Math.sin(i+j)*100,Math.cos(i-j)*100,i+j])}}))),raw=Buffer.concat(records.flatMap(r=>[r,Buffer.from([3])])),input=join(dir,'input'),output=join(dir,'output');await writeFile(input,raw);
 const python:number[]=JSON.parse(execFileSync('python3',['-c',code],{input:JSON.stringify({source,records:input,output,flushEvery}),encoding:'utf8',timeout:60000}));assert.deepEqual(gunzipSync(await readFile(output)),raw);await rm(output);
 const stats=(n:number[])=>{n.sort((a,b)=>a-b);return {medianMs:n[3],p95Ms:n[6]};},modes:Record<string,unknown>={python:stats(python)};
 for(const batch of [1,16]){const times:number[]=[],delays:number[]=[];for(let run=0;run<9;run++){const delay=monitorEventLoopDelay({resolution:1});delay.enable();await new Promise(r=>setTimeout(r,5));delay.reset();const start=performance.now(),writer=await MotanLogWriter.open(output);try{for(let i=0;i<records.length;i+=batch){await writer.addRecords(records.slice(i,i+batch));if((i+batch)%flushEvery===0)await writer.flush();}}finally{await writer.close();}const elapsed=performance.now()-start;delay.disable();if(run>=2){times.push(elapsed);delays.push(delay.max/1e6);}assert.deepEqual(gunzipSync(await readFile(output)),raw);await rm(output);}modes['nodeBatch'+batch]={...stats(times),eventLoopMaximumMs:Math.max(...delays)};}
 results.push({label,records:count,bytes:raw.length,flushEvery,results:modes});
 }console.log(JSON.stringify({node:process.version,zlib:process.versions.zlib,warmups:2,runs:7,results,scope:'Original synchronous Python LogWriter vs async Node compression/file writes, same ETX bytes and full-flush boundaries on local tmpfs. Includes open/close; excludes input generation, verification, socket capture and target-printer load. Node batch 16 may only group records without an intervening index boundary.'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
