import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {AsyncHeaterRuntime} from '../src/thermal/async-runtime.ts';
import {HeaterRuntime} from '../src/thermal/runtime.ts';
import {PIDControl} from '../src/thermal/control.ts';
const samples=20000,config={minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3};
// Exercise the existing Python callback, including its lock and output throttle.
const python=String.raw`
import sys,types,time,threading,importlib.util,json
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
print(json.dumps({'result':result,'times':sorted(times)}))
`;
const processResult=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/extras/heaters.py',import.meta.url))],{encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});
if(processResult.status!==0)throw new Error(processResult.stderr||String(processResult.error));
const oracle=JSON.parse(processResult.stdout) as {result:number[][];times:number[]};
async function run(asynchronous:boolean){
 let time=0,tick=()=>{};const output:number[][]=[],control=new PIDControl({kp:22,ki:1.08,kd:114,smoothTime:1,maxPower:1});
 const clock=()=>({system:time,print:time}),timer=(callback:()=>void)=>{tick=callback;return ()=>{};};
 const runtime=asynchronous?new AsyncHeaterRuntime(config,control,{configuration:{cycleTime:.1,maximumDuration:3,defaultPower:0,initialPower:0},reset:async()=>{},setPWM:async(t,v)=>{output.push([t,v]);},stop:async()=>{}},clock,{},timer):new HeaterRuntime(config,control,{configureMaximumDuration:()=>{},turnOff:()=>{},schedule:(t,v)=>{output.push([t,v]);}},clock,{},timer);
 await runtime.start();runtime.sample(.1,200);await runtime.setTarget(200);
 for(let i=2;i<samples+2;i++){
  time=i*.1;runtime.sample(time,198);if(i%10===0)tick();
  // Same microtask service opportunities for both paths; no simulated UART time.
  if(i%16===0){await Promise.resolve();await Promise.resolve();}
 }
 assert.equal(runtime.status.stopped,false);await runtime.shutdown();return output;
}
assert.deepEqual(await run(false),oracle.result);assert.deepEqual(await run(true),oracle.result);
for(let i=0;i<3;i++){await run(false);await run(true);}
const sync:number[]=[],async:number[]=[];
for(let i=0;i<11;i++)for(const variant of i%2?[true,false]:[false,true]){const start=performance.now();await run(variant);(variant?async:sync).push(performance.now()-start);}
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[5],p95Ms:values[10]};};
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,samples,pwmWrites:oracle.result.length,outputExact:true,python:stats(oracle.times),synchronous:stats(sync),acknowledged:stats(async),extraNanosecondsPerSample:(async[5]-sync[5])*1e6/samples,pythonToAcknowledgedSpeedup:oracle.times[5]/async[5],scope:'Immediate fake ACK, microtask drain, pure thermal control; excludes UART latency and hardware deadlines'},null,2));
assert.ok(async[5]<=oracle.times[5],'Acknowledged thermal runtime regressed against Python');
