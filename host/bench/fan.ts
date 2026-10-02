import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {ScheduledCoolingFan,type FanOutput} from '../src/outputs/fan.ts';
const requests=Array.from({length:20000},(_,i)=>[i*.005,[0,.05,.1,.25,.75,1,2][(Math.imul(i+1,1103515245)>>>0)%7]]);
const python=String.raw`
import sys,json,time,types
requests=json.load(sys.stdin)
fan=open(sys.argv[1]).read().replace('from . import pulse_counter, output_pin','')
queue=open(sys.argv[2]).read();queue=queue[queue.index('class GCodeRequestQueue:'):queue.index('# Template evaluation helper')]
ns={};exec(fan,ns);exec(queue,ns)
def run():
 out=[];f=ns['Fan'].__new__(ns['Fan']);f.last_fan_value=f.last_req_value=0.
 f.max_power=.8;f.kick_start_time=.1;f.off_below=.1
 f.mcu_fan=types.SimpleNamespace(set_pwm=lambda t,v:out.append(['pwm',t,v]))
 f.enable_pin=types.SimpleNamespace(set_digital=lambda t,v:out.append(['enable',t,v]))
 q=ns['GCodeRequestQueue'].__new__(ns['GCodeRequestQueue']);q.rqueue=[];q.next_min_flush_time=0.;q.callback=f._apply_speed
 q.mcu=types.SimpleNamespace(min_schedule_time=lambda:.02);q.motion_queuing=types.SimpleNamespace(note_mcu_movequeue_activity=lambda *a,**k:None)
 for offset in range(0,len(requests),512):
  batch=requests[offset:offset+512]
  for t,v in batch:q._queue_request(t,v)
  q._flush_notification(batch[-1][0],batch[-1][0])
 q._flush_notification(101.,101.)
 return out
for _ in range(3):run()
times=[]
for _ in range(11):
 start=time.perf_counter();out=run();times.append((time.perf_counter()-start)*1000)
print(json.dumps({'out':out,'times':sorted(times)}))
`;
const result=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/extras/fan.py',import.meta.url)),fileURLToPath(new URL('../../klippy/extras/output_pin.py',import.meta.url))],{input:JSON.stringify(requests),encoding:'utf8',maxBuffer:16*1024**2,timeout:60000});if(result.status!==0)throw new Error(result.stderr||String(result.error));const oracle=JSON.parse(result.stdout);
const times:number[]=[];
for(let i=0;i<14;i++){
 const out:(string|number)[][]=[],port=(kind:string):FanOutput=>({configuration:{initialPower:0,defaultPower:0,maximumDuration:0},reset:async()=>{},stop:async()=>{},setPWM:async(t,v)=>{out.push([kind,t,v]);}});
 const signal=new AbortController().signal,start=performance.now(),fan=new ScheduledCoolingFan(port('pwm'),{maxPower:.8,kickStartTime:.1,offBelow:.1,minimumScheduleTime:.02},port('enable'));await fan.start(signal);
 for(let offset=0;offset<requests.length;offset+=512){const batch=requests.slice(offset,offset+512);for(const [time,value] of batch)fan.enqueue(time,value);await fan.flush(batch.at(-1)![0],signal);}await fan.flush(101,signal);const elapsed=performance.now()-start;
 assert.deepEqual(out,oracle.out);assert.equal(fan.status.pending,0);await fan.stop();if(i>=3)times.push(elapsed);
}
times.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,requests:requests.length,exactTransitions:oracle.out.length,samples:11,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10],scope:'Original fan/request-queue calculation versus acknowledged TypeScript scheduler; immediate synthetic output ACKs, not physical fan RPM or transport throughput.'}));
assert(times[5]<=oracle.times[5]*1.5+2,'Cooling fan queue exceeded Python baseline regression budget');
