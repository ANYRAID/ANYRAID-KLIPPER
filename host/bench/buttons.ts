import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {ButtonInput} from '../src/inputs/buttons.ts';
const packets=Array.from({length:10000},(_,i)=>({name:'buttons_state',parameters:{oid:2,ack_count:i&255,state:Buffer.from([i&3])}})).flatMap(p=>[p,p]);
const python=String.raw`
import sys,json,time,types
ns={};exec(open(sys.argv[1]).read(),ns)
def run():
 out=[];acks=[];b=ns['MCU_buttons'].__new__(ns['MCU_buttons']);b.ack_count=b.last_button=0;b.invert=2
 b.callbacks=[(3,0,lambda t,s:out.append(s))];b.ack_cmd=types.SimpleNamespace(send=lambda p:acks.append(p[1]));b.oid=2
 b.reactor=types.SimpleNamespace(register_async_callback=lambda f:f(0))
 for i in range(10000):
  p={'ack_count':i&255,'state':bytes([i&3]),'#receive_time':i}
  b.handle_buttons_state(p);b.handle_buttons_state(p)
 return out,acks
samples=[]
for i in range(14):
 start=time.perf_counter();out,acks=run();elapsed=(time.perf_counter()-start)*1000
 if i>=3:samples.append(elapsed)
print(json.dumps({'states':out,'acks':acks,'times':sorted(samples)}))
`;
const result=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/extras/buttons.py',import.meta.url))],{encoding:'utf8',timeout:60000,maxBuffer:2*1024**2});if(result.status!==0)throw new Error(result.stderr||String(result.error));const reference=JSON.parse(result.stdout),times:number[]=[];
for(let i=0;i<14;i++){const d=new ButtonInput({oid:2,count:2,invert:2}),states:number[]=[],acks:number[]=[],begin=performance.now();for(const p of packets){const b=d.receive(p);if(!b)continue;acks.push(b.ack);for(const sample of b.samples)if(sample.changed)states.push(sample.state);}const elapsed=performance.now()-begin;assert.deepEqual(states,reference.states);assert.deepEqual(acks,reference.acks);assert.equal(d.status.acknowledged,10000n);if(i>=3)times.push(elapsed);}
times.sort((a,b)=>a-b);assert(times[5]<=reference.times[5]*1.5+2);
console.log(JSON.stringify({node:process.version,packets:packets.length,acceptedSamples:10000,duplicateReports:10000,counterWraps:39,samples:11,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:reference.times[5],pythonP95Ms:reference.times[10],scope:'Original Python button decoder with immediate callbacks versus TS immutable batches; exact ACK counts and states, excludes MCU IO'}));
