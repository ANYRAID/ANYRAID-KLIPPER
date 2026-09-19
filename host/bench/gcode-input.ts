import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {GCodeInput} from '../src/gcode/input.ts';
const lines=Array.from({length:10000},(_,i)=>`G1X${i*.01}Y-${i%53}.125E.02F6000`),script=lines.join('\n');
const python=String.raw`
import sys,json,time,importlib.util,collections,contextlib
spec=importlib.util.spec_from_file_location('gcode',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
lines=json.load(open(sys.argv[2]));output=[];positions=[]
g=m.GCodeDispatch.__new__(m.GCodeDispatch);g.respond_info=lambda *a:None;g.respond_raw=output.append;g.cmd_default=lambda c:None
g.gcode_handlers={'G1':lambda c:positions.append([c.get_float('X'),c.get_float('Y'),c.get_float('E'),c.get_float('F')])}
data=('\n'.join(lines)+'\n').encode();chunks=[data[i:i+4096] for i in range(0,len(data),4096)]
io=m.GCodeIO.__new__(m.GCodeIO);io.fd=42;io.gcode=g;io.gcode_mutex=contextlib.nullcontext();io.is_fileinput=False;io.fd_handle=1
reads=collections.deque();m.os.read=lambda fd,size:reads.popleft()
def run():
 output.clear();positions.clear();io.partial_input='';io.pending_commands=[];io.input_log=collections.deque([],50);io.bytes_read=0;io.is_processing_data=False
 reads.extend(chunks)
 while reads:io._process_data(0.)
run();result={'output':list(output),'positions':list(positions)}
for _ in range(3):run()
times=[]
for _ in range(11):
 start=time.perf_counter();run();times.append((time.perf_counter()-start)*1000)
print(json.dumps({'result':result,'times':sorted(times)}))
`;
const dir=mkdtempSync(join(tmpdir(),'anyraid-dispatch-'));let oracle;
try {
 const input=join(dir,'input.json');writeFileSync(input,JSON.stringify(lines));
 const p=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/gcode.py',import.meta.url)),input],{encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});
 if(p.status!==0)throw new Error(p.stderr||String(p.error));oracle=JSON.parse(p.stdout);
}finally{rmSync(dir,{recursive:true,force:true});}
const output:string[]=[],positions:number[][]=[];
const d=new GCodeDispatch({output:m=>output.push(m),shutdown:reason=>{throw new Error(reason);}});d.setReady(true);
d.register('G1',c=>{positions.push(['X','Y','E','F'].map(k=>{const n=Number(c.params[k]);if(!Number.isFinite(n))throw new Error('Invalid number');return n;}));});
const bytes=Buffer.from(script+'\n');
async function run(){output.length=0;positions.length=0;const input=new GCodeInput(d);for(let i=0;i<bytes.length;i+=4096)input.receive(bytes.subarray(i,i+4096));await input.end();}
await run();assert.deepEqual({output,positions},oracle.result);
for(let i=0;i<3;i++)await run();const times=[];const delay=monitorEventLoopDelay({resolution:1});delay.enable();
for(let i=0;i<11;i++){const start=performance.now();await run();times.push(performance.now()-start);}delay.disable();times.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,commands:lines.length,exact:true,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10],speedup:oracle.times[5]/times[5],eventLoopP99Ms:delay.percentile(99)/1e6,eventLoopMaxMs:delay.max/1e6},null,2));
assert.ok(times[5]<=oracle.times[5],'G-code input regressed against Python');
