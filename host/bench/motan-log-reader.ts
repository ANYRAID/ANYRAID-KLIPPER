import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {gzipSync} from 'node:zlib';
import {MotanLogReader} from '../src/motan/log-reader.ts';
const dir=await mkdtemp(join(tmpdir(),'motan-reader-bench-')),results:unknown[]=[],source=execFileSync('git',['show','2c7ba578:scripts/motan/readlog.py'],{encoding:'utf8'});
assert.equal(createHash('sha256').update(source).digest('hex'),'f89b7eff1f4592399d9eb9ad0f679d894cb9a0d2a40a79f81f48d139c16e9ca2');
const python=String.raw`import ast,json,sys,time,zlib
tree=ast.parse(sys.stdin.read());tree.body=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='JsonLogReader'];ns={'json':json,'zlib':zlib};exec(compile(tree,'original-motan-reader','exec'),ns);times=[]
for run in range(9):
    start=time.perf_counter();r=ns['JsonLogReader'](sys.argv[1]);count=total=0
    while True:
        msg=r.pull_msg()
        if msg is None:break
        count+=1;total+=msg['id']
    r.file.close()
    if run>=2:times.append((time.perf_counter()-start)*1000)
print(json.dumps({'times':times,'count':count,'total':total}))`;
try{for(const [label,count,rows] of [['small',30000,1],['bulk',128,1024]] as const){const path=join(dir,'log'),records=Array.from({length:count},(_,id)=>JSON.stringify({id,params:{data:Array.from({length:rows},(_,i)=>[id+i/rows,Math.sin(id+i),Math.cos(id-i)])}})),raw=Buffer.from(records.join('\x03')+'\x03');await writeFile(path,gzipSync(raw));const expected=count*(count-1)/2,old=JSON.parse(execFileSync('python3',['-c',python,path],{input:source,encoding:'utf8',timeout:60000}));assert.equal(old.count,count);assert.equal(old.total,expected);const modes:Record<string,unknown>={},stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[3],p95Ms:values[6]};};modes.python=stats(old.times);
 for(const batch of [1,256]){const times:number[]=[],delays:number[]=[];for(let run=0;run<9;run++){const monitor=monitorEventLoopDelay({resolution:1});monitor.enable();await new Promise(r=>setTimeout(r,5));monitor.reset();const start=performance.now(),reader=await MotanLogReader.open(path);let received=0,total=0;try{for(;;){const messages=await reader.pullMessages(batch);if(!messages.length)break;for(const message of messages){received++;total+=message.id as number;}}}finally{await reader.close();}const elapsed=performance.now()-start;monitor.disable();if(run>=2){times.push(elapsed);delays.push(monitor.max/1e6);}assert.equal(received,count);assert.equal(total,expected);}modes['nodeBatch'+batch]={...stats(times),eventLoopMaximumMs:Math.max(...delays)};}
 results.push({label,count,rawBytes:raw.length,gzipBytes:(await readFile(path)).length,results:modes});
 }console.log(JSON.stringify({node:process.version,zlib:process.versions.zlib,warmups:2,runs:7,results,scope:'Original Python JsonLogReader vs Node streaming reader over identical local gzip files. Includes decompression, exact JSON numeric boundary checks, message iteration and open/close; input construction excluded. Node strict EOF validation is additional. No target-board or concurrent-print proof.'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
