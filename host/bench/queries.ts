import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {QueryConnection} from '../src/protocol/queries.ts';
import {FakeClock} from '../test/helpers/clock-scheduler.ts';
const count=5000,clock=new FakeClock(),signal=new AbortController().signal;
let q:QueryConnection,received=0;
q=new QueryConnection({async send(){q.receive({message:{name:'clock',parameters:{clock:++received}},sentTime:clock.time,receiveTime:clock.time});},setClockEstimate(){},async stop(){}},clock);
const times:number[]=[];for(let run=0;run<14;run++){const before=performance.now();for(let i=0;i<count;i++){const value=await q.query(Uint8Array.of(3),'clock',signal);assert.equal(value.message.parameters.clock,run*count+i+1);}if(run>=3)times.push(performance.now()-before);}assert.equal(clock.pending,0);await q.stop('benchmark ended');times.sort((a,b)=>a-b);
const retryTraces:number[][]=[];
for(let misses=0;misses<=6;misses++){
 const t=new FakeClock(),trace:number[]=[];let c:QueryConnection;
 c=new QueryConnection({async send(){trace.push(t.time);if(trace.length>misses)c.receive({message:{name:'clock',parameters:{clock:42}},sentTime:t.time,receiveTime:t.time});},setClockEstimate(){},async stop(){}},t);
 const done=c.query(Uint8Array.of(3),'clock',signal,{retries:5}).then(()=>true,()=>false);await t.advance(.32);assert.equal(await done,misses<6);retryTraces.push(trace.map(n=>Math.round((n-10)*1000)));await c.stop('done');assert.equal(t.pending,0);
}
const python=String.raw`
import ast,sys,time,json,types
source=open(sys.argv[1]).read();node=next(n for n in ast.parse(source).body if isinstance(n,ast.ClassDef) and n.name=='SerialRetryCommand')
error=RuntimeError;exec(ast.get_source_segment(source,node),globals())
class Serial:
 def __init__(self,misses=0):
  self.time=10.;self.trace=[];self.misses=misses;self.calls=0
  self.reactor=types.SimpleNamespace(monotonic=lambda:self.time,pause=self.pause)
 def pause(self,t):self.time=t
 def register_response(self,callback,name,oid):self.callback=callback
 def raw_send_wait_ack(self,*args):
  self.calls+=1
  if self.calls>self.misses:self.callback({'clock':self.calls,'#sent_time':self.time,'#receive_time':self.time})
 def raw_send(self,*args):pass
samples=[];s=Serial()
for run in range(14):
 begin=time.perf_counter()
 for i in range(5000):
  result=SerialRetryCommand(s,'clock').get_response([bytes([3])],None,retry=False)
  assert result['clock']==run*5000+i+1
 if run>=3:samples.append((time.perf_counter()-begin)*1000)
traces=[]
for misses in range(7):
 s=Serial(misses);old=s.raw_send_wait_ack
 def send(*args):s.trace.append(round((s.time-10)*1000));old(*args)
 s.raw_send_wait_ack=send
 try:SerialRetryCommand(s,'clock').get_response([bytes([3])],None);assert misses<6
 except RuntimeError:assert misses==6
 traces.append(s.trace)
print(json.dumps({'samples':sorted(samples),'traces':traces,'python':sys.version.split()[0]}))
`;
const result=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/serialhdl.py',import.meta.url))],{encoding:'utf8',timeout:60000});assert.equal(result.status,0,result.stderr);const reference=JSON.parse(result.stdout);assert.deepEqual(retryTraces,reference.traces);
console.log(JSON.stringify({node:process.version,python:reference.python,cpu:cpus()[0].model,queries:count,retryFixtures:retryTraces.length,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:reference.samples[5],pythonP95Ms:reference.samples[10],nodeMedianUsPerQuery:times[5]*1000/count,scope:'In-memory acknowledged queries; TS includes Promise, cancellation, deadlines and response cloning; Python reactor/C ACK transport mocked. No wire or hardware throughput claim.'},null,2));
