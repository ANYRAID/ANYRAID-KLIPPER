import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {GcodeStore} from '../src/moonraker/gcode-store.ts';
import {gcodeStoreOracle} from '../test/helpers/gcode-store-oracle.ts';
const count=100000,messages=['G1 X1 Y2 E0.1\nG1 X2 Y3 E0.2','ok T:210.25 B:60.0',' \n','// 中文响应'];
const samples:number[]=[],queries:number[]=[];
for(let run=0;run<13;run++){
 const store=new GcodeStore(1000,8*1024*1024,()=>100);let start=performance.now();
 for(let i=0;i<count;i++)store.record(messages[i%4],i%2?'response':'command');
 const elapsed=performance.now()-start;assert.equal(store.status.records,1000);
 start=performance.now();for(let i=0;i<10000;i++)assert.equal(store.snapshot(20).gcode_store.length,20);const queryMs=performance.now()-start;
 if(run>=2){samples.push(elapsed);queries.push(queryMs);}
}
const oracle=gcodeStoreOracle(),program=oracle.slice(0,oracle.indexOf('async def main():'))+`
values=[]
time.time=lambda:100
messages=json.loads(sys.stdin.read())
for run in range(13):
 store=DataStore.__new__(DataStore);store.gcode_queue=deque(maxlen=1000)
 start=time.perf_counter()
 for i in range(100000):
  if i%2: store._update_gcode_store(messages[i%4])
  else: store._store_gcode_command(messages[i%4])
 elapsed=(time.perf_counter()-start)*1000
 assert len(store.gcode_queue)==1000
 if run>=2: values.append(elapsed)
print(json.dumps(values))
`;
const result=spawnSync('/usr/bin/python3',['-c',program],{input:JSON.stringify(messages),encoding:'utf8'});assert.equal(result.status,0,result.stderr);
function stats(values:number[]){values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(values.length/2)],p95Ms:values[Math.ceil(values.length*.95)-1]};}
console.log(JSON.stringify({node:process.version,recordsPerRun:count,retained:1000,clock:'fixed on both sides',nodeAppend:stats(samples),pythonAppend:stats(JSON.parse(result.stdout)),nodeTail20Queries10000:stats(queries),scope:'in-process history only; excludes transport, GC tail latency and hardware'},null,2));
