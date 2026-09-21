import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {mcuDumpChunks} from '../src/diagnostics/mcu-dump.ts';
const ranges=[{start:0xffffc000,length:16384},{start:2,length:16382},{start:3,length:16381}];
const source=String.raw`
import sys,types,runpy,json,io,time,hashlib
for name in ['reactor','serialhdl','clocksync']:sys.modules[name]=types.ModuleType(name)
r=runpy.run_path(sys.argv[1]);cases=json.load(sys.stdin);results=[]
def value(addr):return (addr*2654435761)&0xffffffff
class Serial:
 def send_with_response(self,cmd,response):
  assert response=='debug_result'
  fields=dict(x.split('=') for x in cmd.split()[1:]);a=int(fields['addr']);o=int(fields['order']);commands.append([o,a]);return {'val':value(a)}
class Output(io.BytesIO):
 def close(self):captured.append(self.getvalue());super().close()
f=r['MCUDump']._dump_flash;f.__globals__.update(output=lambda *a:None,output_line=lambda *a:None,open=lambda *a:Output())
for case in cases:
 obj=r['MCUDump'].__new__(r['MCUDump']);obj.read_start=case['start'];obj.read_length=case['length'];obj.output_file='mock';obj._serial=Serial();samples=[]
 for run in range(16):
  commands=[];captured=[];at=time.perf_counter();f(obj)
  if run>=5:samples.append((time.perf_counter()-at)*1000)
 samples.sort();results.append(dict(bytes=hashlib.sha256(captured[0]).hexdigest(),commands=hashlib.sha256(json.dumps(commands,separators=(',',':')).encode()).hexdigest(),medianMs=samples[5],p95Ms=samples[10]))
print(json.dumps(dict(python=sys.version.split()[0],results=results)))
`;
const baseline=JSON.parse(execFileSync(process.env.PYTHON??'/usr/bin/python3',['-c',source,fileURLToPath(new URL('../../scripts/dump_mcu.py',import.meta.url))],{input:JSON.stringify(ranges),encoding:'utf8',maxBuffer:1024**2}));
const hash=(data:Uint8Array|string)=>createHash('sha256').update(data).digest('hex'),results=[];
for(const [index,range] of ranges.entries()){
 const samples=[];let bytes=Buffer.alloc(0),commands:number[][]=[];
 for(let run=0;run<16;run++){commands=[];const chunks=[],start=performance.now();for await(const chunk of mcuDumpChunks(async(order,address)=>{commands.push([order,address]);return Number((BigInt(address)*2654435761n)&0xffffffffn);},range,new AbortController().signal))chunks.push(chunk);bytes=Buffer.concat(chunks);if(run>=5)samples.push(performance.now()-start);}
 assert.equal(hash(bytes),baseline.results[index].bytes);assert.equal(hash(JSON.stringify(commands)),baseline.results[index].commands);samples.sort((a,b)=>a-b);results.push({range,requests:commands.length,sha256:hash(bytes),node:{medianMs:samples[5],p95Ms:samples[10]},python:baseline.results[index]});
}
console.log(JSON.stringify({node:process.version,python:baseline.python,warmups:5,runs:11,results,scope:'Original Python _dump_flash with serial/file/progress substitutes versus Node asynchronous bounded chunks. Includes mock values, request recording and output assembly; Python also parses text commands and formats suppressed progress. Excludes actual serial ACKs, file I/O, device memory latency and print timing.'},null,2));
