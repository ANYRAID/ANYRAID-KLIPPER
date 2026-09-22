import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {gunzipSync} from 'node:zlib';
import {MotanCapture} from '../src/motan/capture.ts';
import {MotanLogWriter} from '../src/motan/log-writer.ts';
import {ConsoleFrames} from '../src/diagnostics/webhook-console.ts';
const source=execFileSync('git',['show','26cea9bb:scripts/motan/data_logger.py'],{encoding:'utf8'}),dir=await mkdtemp(join(tmpdir(),'motan-capture-bench-')),results:unknown[]=[];
assert.equal(createHash('sha256').update(source).digest('hex'),'0089711b4861c6a043de27b916edaa74d0dd2039b8f6738dc0a734a6746436a4');
const python=String.raw`import json,sys,time,contextlib,io,gzip
v=json.load(sys.stdin);ns={'__name__':'benchmark'};exec(v['source'],ns)
raw=open(v['input'],'rb').read();times=[]
class Socket:
    def __init__(self): self.position=0
    def send(self,data): return len(data)
    def recv(self,size):
        data=raw[self.position:self.position+65536];self.position+=len(data);return data
for run in range(9):
    with contextlib.redirect_stdout(io.StringIO()):
        start=time.perf_counter();dl=ns['DataLogger'].__new__(ns['DataLogger']);dl.webhook_socket=Socket();dl.socket_data=b'';dl.logger=ns['LogWriter'](v['output']+'.json.gz');dl.index=ns['LogWriter'](v['output']+'.index.gz');dl.query_handlers={};dl.async_handlers={};dl.db={};dl.next_index_time=0.;dl.want_subscriptions=['*'];dl.need_subscriptions=[];dl.send_query('info','info',{'client_info':ns['ClientInfo']},dl.handle_info)
        while dl.webhook_socket.position<len(raw):dl.process_socket()
        dl.logger.close();dl.index.close()
        if run>=2:times.append((time.perf_counter()-start)*1000)
print(json.dumps(times))`;
try{for(const [label,count,rows,indexEvery] of [['small-high-rate',4096,1,1024],['small-frequent-index',4096,1,16],['bulk',128,1024,16]] as const){
 const messages:unknown[]=[{id:'info',result:{state:'ready'}},{id:'list',result:{objects:['configfile','motion_report']}},{id:'status',result:{eventtime:0,status:{configfile:{settings:{}},motion_report:{trapq:[],steppers:['stepper_x']}}}},{id:'stepq:stepper_x',result:{header:['time','value']}}];
 for(let i=0;i<count;i++){messages.push({q:'stepq:stepper_x',params:{data:Array.from({length:rows},(_,j)=>[i+j/rows,Math.sin(i+j)*100,Math.cos(i-j)*100,i+j])}});if((i+1)%indexEvery===0)messages.push({q:'status',params:{eventtime:(i+1)/indexEvery*5,status:{toolhead:{position:[i,0,0]}}}});}
 const raw=Buffer.from(messages.map(m=>JSON.stringify(m)+'\x03').join('')),input=join(dir,'input'),prefix=join(dir,'output');await writeFile(input,raw);
 const oldTimes:number[]=JSON.parse(execFileSync('python3',['-c',python],{input:JSON.stringify({source,input,output:prefix}),encoding:'utf8',timeout:60000}));assert.deepEqual(gunzipSync(await readFile(prefix+'.json.gz')),raw);const oldIndexes=gunzipSync(await readFile(prefix+'.index.gz')).toString().split('\x03').filter(Boolean).map(s=>{const v=JSON.parse(s);delete v.file_position;return v;});await rm(prefix+'.json.gz');await rm(prefix+'.index.gz');
 const times:number[]=[],delays:number[]=[];for(let run=0;run<9;run++){const monitor=monitorEventLoopDelay({resolution:1});monitor.enable();await new Promise(r=>setTimeout(r,5));monitor.reset();const start=performance.now(),log=await MotanLogWriter.open(prefix+'.json.gz'),index=await MotanLogWriter.open(prefix+'.index.gz'),capture=new MotanCapture({log,index},async()=>{},['*'],()=>{}),frames=new ConsoleFrames(3);try{await capture.start();for(let i=0;i<raw.length;i+=65536)await capture.accept(frames.push(raw.subarray(i,i+65536)));assert.equal(frames.pending,0);}finally{await Promise.all([log.close(),index.close()]);}const elapsed=performance.now()-start;monitor.disable();if(run>=2){times.push(elapsed);delays.push(monitor.max/1e6);}assert.deepEqual(gunzipSync(await readFile(prefix+'.json.gz')),raw);const indexes=gunzipSync(await readFile(prefix+'.index.gz')).toString().split('\x03').filter(Boolean).map(s=>{const v=JSON.parse(s);delete v.file_position;return v;});assert.deepEqual(indexes,oldIndexes);await rm(prefix+'.json.gz');await rm(prefix+'.index.gz');}
 const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[3],p95Ms:values[6]};};results.push({label,indexEvery,frames:messages.length,bytes:raw.length,indexes:oldIndexes.length,python:stats(oldTimes),node:{...stats(times),eventLoopMaximumMs:Math.max(...delays)}});
 }console.log(JSON.stringify({node:process.version,zlib:process.versions.zlib,warmups:2,runs:7,results,scope:'Complete capture parsing, subscription/status state, batching, gzip log and index publication over 64 KiB input chunks; exact raw logs and semantic index snapshots compared to original Python DataLogger. Includes file open/close. Socket and process startup excluded; local storage only, no target-printer concurrency proof.'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
