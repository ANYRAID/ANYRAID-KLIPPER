import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {decodeCanDiscovery} from '../src/diagnostics/can-query.ts';
// Original complete query loop with in-memory CAN/time/stdout substitutes.
const source=String.raw`
import sys,types,runpy,json,time,io,contextlib
request=json.load(sys.stdin);frames=request['frames'];can=types.ModuleType('can');can.Message=lambda **kw:kw;sys.modules['can']=can
r=runpy.run_path(sys.argv[1]);samples=[];output=''
class Bus:
 def __init__(self,**kw): self.i=0
 def send(self,msg): assert msg==dict(arbitration_id=0x3f0,data=[0],is_extended_id=False)
 def recv(self,timeout):
  if self.i>=len(frames):clock[0]=3;return None
  row=frames[self.i];self.i+=1;return types.SimpleNamespace(arbitration_id=row['id'],data=row['data'],dlc=len(row['data']))
can.interface=types.SimpleNamespace(Bus=Bus);r['query_unassigned'].__globals__['time']=types.SimpleNamespace(time=lambda:clock[0])
for i in range(16):
 clock=[0];out=io.StringIO();start=time.perf_counter()
 with contextlib.redirect_stdout(out):r['query_unassigned']('mock')
 elapsed=(time.perf_counter()-start)*1000
 if i>=5:samples.append(elapsed)
 output=out.getvalue()
print(json.dumps(dict(samples=samples,output=output,python=sys.version.split()[0])))
`;
const frames=Array.from({length:10000},(_,i)=>({id:0x3f1,data:[32,255,255,0,0,(i%4096)>>8,i%256,...i%3?[i%3===1?17:99]:[]]}));
const baseline=JSON.parse(execFileSync(process.env.PYTHON??'/usr/bin/python3',['-c',source,fileURLToPath(new URL('../../scripts/canbus_query.py',import.meta.url))],{input:JSON.stringify({frames}),encoding:'utf8',maxBuffer:8*1024**2}));
const buffers=frames.map(f=>({id:f.id,data:Uint8Array.from(f.data)})),samples:number[]=[];let output='';
for(let run=0;run<16;run++){const start=performance.now(),found=new Set<string>();output='';for(const f of buffers){const d=decodeCanDiscovery(f);if(d&&!found.has(d.uuid)){found.add(d.uuid);output+=`Found canbus_uuid=${d.uuid}, Application: ${d.application}\n`;}}output+=`Total ${found.size} uuids found\n`;if(run>=5)samples.push(performance.now()-start);}
assert.equal(output,baseline.output);
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};
console.log(JSON.stringify({node:process.version,python:baseline.python,frames:frames.length,uniqueDevices:4096,warmups:5,runs:11,nodeDecode:stats(samples),pythonQuery:stats(baseline.samples),scope:'In-memory response decoding, UUID deduplication and report formatting. Python includes its original loop and mock transport dispatch; Node excludes transport polling. No physical CAN, two-second wait, startup or print throughput measurement.'},null,2));
