import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {PIDControl,BangBangControl,HeaterPWM} from '../src/thermal/control.ts';
const samples=Array.from({length:20000},(_,i)=>({time:(i+1)*.1,temp:25+180*(1-Math.exp(-i/300))+3*Math.sin(i*.017),target:i%4000<3000?200:0}));
const python=String.raw`
import ast,json,sys,time,types
text=open(sys.argv[1]).read();data=json.load(open(sys.argv[2]))
AMBIENT_TEMP=25.;PID_PARAM_BASE=255.;PID_SETTLE_DELTA=1.;PID_SETTLE_SLOPE=.1;MAX_HEAT_TIME=3.
for name in ['ControlPID','ControlBangBang','Heater']:
 node=next(n for n in ast.parse(text).body if isinstance(n,ast.ClassDef) and n.name==name);exec(ast.get_source_segment(text,node),globals())
def run(kind):
 output=[];heater=types.SimpleNamespace(get_max_power=lambda:.8,get_smooth_time=lambda:1.,set_pwm=lambda t,v:output.append(v))
 config=types.SimpleNamespace(getfloat=lambda k,*a,**kw:{'pid_Kp':22.,'pid_Ki':0. if kind=='zero' else 1.08,'pid_Kd':114.,'max_delta':2.}[k])
 p=ControlBangBang(heater,config) if kind=='bang' else ControlPID(heater,config);result=[]
 for s in data:
  p.temperature_update(s['time'],s['temp'],s['target'])
  result.append([output[-1],p.check_busy(0,s['temp'],s['target'])]+([p.prev_temp,p.prev_temp_time,p.prev_temp_deriv,p.prev_temp_integ] if kind!='bang' else [p.heating]))
 return result
results=[run(k) for k in ['pid','zero','bang']]
def run_pwm():
 h=Heater.__new__(Heater);h.target_temp=200.;h.verify_mainthread_time=5.;h.next_pwm_time=0.;h.last_pwm_value=0.;h.pwm_delay=.3;h.min_pwm_change=.04
 pwm=[];h.mcu_pwm=types.SimpleNamespace(set_pwm=lambda t,v:pwm.append([t,v]))
 for i,s in enumerate(data):
  if i%10==0 and not 10000<=i<10100:h.verify_mainthread_time=s['time']+5
  h.target_temp=s['target'];h.set_pwm(s['time'],(i%9)*.1)
 return pwm
pwm=run_pwm()
for _ in range(3):run('pid')
times=[]
for _ in range(11):
 start=time.perf_counter();run('pid');times.append((time.perf_counter()-start)*1000)
extra={}
for name,fn in [('bang',lambda:run('bang')),('pwm',run_pwm)]:
 for _ in range(3):fn()
 measurements=[]
 for _ in range(11):
  start=time.perf_counter();fn();measurements.append((time.perf_counter()-start)*1000)
 extra[name]=sorted(measurements)
print(json.dumps({'results':results,'pwm':pwm,'times':sorted(times),'extra':extra}))
`;
const dir=mkdtempSync(join(tmpdir(),'anyraid-thermal-'));let oracle:{results:unknown[][];pwm:number[][];times:number[];extra:Record<string,number[]>};
try{const input=join(dir,'input.json');writeFileSync(input,JSON.stringify(samples));const p=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/extras/heaters.py',import.meta.url)),input],{encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024});if(p.status!==0)throw new Error(p.stderr||String(p.error));oracle=JSON.parse(p.stdout);}finally{rmSync(dir,{recursive:true,force:true});}
function run(kind:string){
 const p=kind==='bang'?new BangBangControl(.8,2):new PIDControl({kp:22,ki:kind==='zero'?0:1.08,kd:114,smoothTime:1,maxPower:.8});
 return samples.map(s=>{const output=p.update(s.time,s.temp,s.target),busy=p.busy(s.temp,s.target);if(p instanceof PIDControl){const t=p.state;return [output,busy,t.temperature,t.time,t.derivative,t.integral];}return [output,busy,p.heating];});
}
['pid','zero','bang'].forEach((k,i)=>assert.deepEqual(run(k),oracle.results[i]));
function runPWM(){const pwm:number[][]=[],gate=new HeaterPWM(.8,.3);
samples.forEach((s,i)=>{if(i%10===0&&!(i>=10000&&i<10100))gate.heartbeat(s.time);const v=gate.update(s.time,(i%9)*.1,s.target);if(v)pwm.push([v.time,v.power]);});return pwm;}
const pwm=runPWM();assert.deepEqual(pwm,oracle.pwm);
const extra:Record<string,unknown>={};
for(const [name,fn] of [['bang',()=>run('bang')],['pwm',runPWM]] as const){for(let i=0;i<3;i++)fn();const values=[];for(let i=0;i<11;i++){const start=performance.now();fn();values.push(performance.now()-start);}values.sort((a,b)=>a-b);extra[name]={nodeMedianMs:values[5],nodeP95Ms:values[10],pythonMedianMs:oracle.extra[name][5],pythonP95Ms:oracle.extra[name][10]};assert.ok(values[5]<=oracle.extra[name][5],name+' regressed');}
for(let i=0;i<3;i++)run('pid');const times=[];for(let i=0;i<11;i++){const start=performance.now();run('pid');times.push(performance.now()-start);}times.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,controllerSamples:samples.length*3,pwmRequests:samples.length,pwmWrites:pwm.length,statesExact:true,extra,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10],speedup:oracle.times[5]/times[5]},null,2));assert.ok(times[5]<=oracle.times[5],'PID regressed against Python');
