import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {TemperatureState} from '../src/thermal/state.ts';
const samples=Array.from({length:50000},(_,i)=>[(i+1)*.1,25+180*(1-Math.exp(-i/300))+3*Math.sin(i*.017),i%4000<3000?200:0]);
const python=String.raw`
import sys,ast,json,time,types,threading
text=open(sys.argv[1]).read();node=next(n for n in ast.parse(text).body if isinstance(n,ast.ClassDef) and n.name=='Heater');exec(ast.get_source_segment(text,node),globals());QUELL_STALE_TIME=7.;data=json.load(open(sys.argv[2]))
def run():
 h=Heater.__new__(Heater);h.min_temp=0.;h.max_temp=300.;h.min_extrude_temp=170.;h.inv_smooth_time=1.;h.last_temp=h.last_temp_time=h.smoothed_temp=h.target_temp=0.;h.lock=threading.Lock();h.can_extrude=False
 h.control=types.SimpleNamespace(temperature_update=lambda *a:None);mcu=types.SimpleNamespace(estimated_print_time=lambda t:t);h.mcu_pwm=types.SimpleNamespace(get_mcu=lambda:mcu);out=[]
 for t,temp,target in data:
  h.set_temp(target);h.temperature_callback(t,temp);current,goal=h.get_temp(t)
  out.append([h.last_temp,h.last_temp_time,h.smoothed_temp,current,goal,h.can_extrude])
 return out
result=run()
for _ in range(3):run()
times=[]
for _ in range(11):
 start=time.perf_counter();run();times.append((time.perf_counter()-start)*1000)
print(json.dumps({'result':result,'times':sorted(times)}))
`;
const dir=mkdtempSync(join(tmpdir(),'anyraid-temperature-'));let oracle:{result:unknown;times:number[]};
try{const path=join(dir,'input.json');writeFileSync(path,JSON.stringify(samples));const p=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/extras/heaters.py',import.meta.url)),path],{encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024});if(p.status!==0)throw new Error(p.stderr||String(p.error));oracle=JSON.parse(p.stdout);}finally{rmSync(dir,{recursive:true,force:true});}
function run(){const h=new TemperatureState({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1});return samples.map(([t,temp,target])=>{h.setTarget(target);h.sample(t,temp);const s=h.state,v=h.status(t);return [s.lastTemperature,s.lastTime,s.smoothedTemperature,v.temperature,v.target,v.canExtrude];});}
assert.deepEqual(run(),oracle.result);for(let i=0;i<3;i++)run();const times=[];for(let i=0;i<11;i++){const start=performance.now();run();times.push(performance.now()-start);}times.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,samples:samples.length,statesExact:true,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10],speedup:oracle.times[5]/times[5]},null,2));assert.ok(times[5]<=oracle.times[5],'Temperature state regressed against Python');
