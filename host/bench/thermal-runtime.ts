import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import assert from 'node:assert/strict';
import {HeaterRuntime} from '../src/thermal/runtime.ts';
import {PIDControl} from '../src/thermal/control.ts';
const python=String.raw`
import sys,types,time,threading,importlib.util
spec=importlib.util.spec_from_file_location('heaters',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def run():
 out=[];h=m.Heater.__new__(m.Heater);h.max_power=1.;h.smooth_time=1.;h.inv_smooth_time=1.;h.min_temp=0.;h.max_temp=300.;h.min_extrude_temp=170.;h.last_temp=h.last_temp_time=h.smoothed_temp=h.target_temp=0.;h.lock=threading.Lock();h.can_extrude=False
 h.pwm_delay=.3;h.next_pwm_time=0.;h.last_pwm_value=0.;h.min_pwm_change=.05;h.verify_mainthread_time=5.;h.mcu_pwm=types.SimpleNamespace(set_pwm=lambda t,v:out.append([t,v]))
 cfg=types.SimpleNamespace(getfloat=lambda key:{'pid_Kp':22.,'pid_Ki':1.08,'pid_Kd':114.}[key]);h.control=m.ControlPID(h,cfg)
 h.temperature_callback(.1,200.);h.set_temp(200.)
 for i in range(2,20002):
  t=i*.1;h.temperature_callback(t,198.)
  if i%10==0:h.verify_mainthread_time=t+5
 return out
result=run()
for _ in range(3):run()
times=[]
for _ in range(11):
 start=time.perf_counter();run();times.append((time.perf_counter()-start)*1000)
import json;print(json.dumps({'result':result,'times':sorted(times)}))
`;
const p=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/extras/heaters.py',import.meta.url))],{encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});if(p.status!==0)throw new Error(p.stderr||String(p.error));const oracle=JSON.parse(p.stdout);
function run(){let time=0,tick=()=>{};const out:number[][]=[];const r=new HeaterRuntime({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3},new PIDControl({kp:22,ki:1.08,kd:114,smoothTime:1,maxPower:1}),{configureMaximumDuration:()=>{},turnOff:()=>{},schedule:(t,v)=>out.push([t,v])},()=>({system:time,print:time}),{},fn=>{tick=fn;return ()=>{};});
 r.start();r.sample(.1,200);r.setTarget(200);
 for(let i=2;i<20002;i++){time=i*.1;r.sample(time,198);if(i%10===0)tick();}
 assert.equal(r.status.stopped,false);r.shutdown();return out;
}
assert.ok(oracle.result.length>100);assert.deepEqual(run(),oracle.result);for(let i=0;i<3;i++)run();const times=[];for(let i=0;i<11;i++){const t=performance.now();run();times.push(performance.now()-t);}times.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,samples:20000,outputExact:true,pwmWrites:oracle.result.length,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10],speedup:oracle.times[5]/times[5]},null,2));assert.ok(times[5]<=oracle.times[5],'Thermal runtime regressed');
