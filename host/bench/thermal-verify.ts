import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {HeaterCheck} from '../src/thermal/verify.ts';
const traces=Array.from({length:200},(_,i)=>({config:{hysteresis:i%3===0?0:5,maxError:[0,15,120][i%3],heatingGain:2,checkGainTime:[1,20,60][i%3]},samples:Array.from({length:250},(_,t)=>[t,25+Math.min(175,t*(i%5))+(t%17===0?-10:0),t<150?200:t<200?220:0])}));
const python=String.raw`
import sys,json,ast,time,types,logging
logging.disable(logging.CRITICAL)
text=open(sys.argv[1]).read();node=next(n for n in ast.parse(text).body if isinstance(n,ast.ClassDef) and n.name=='HeaterCheck');exec(ast.get_source_segment(text,node),globals());HINT_THERMAL='';data=json.load(open(sys.argv[2]))
def run():
 results=[]
 for trace in data:
  fault=[False];printer=types.SimpleNamespace(register_event_handler=lambda *a:None,get_reactor=lambda:types.SimpleNamespace(NEVER=float('inf')),invoke_shutdown=lambda m:fault.__setitem__(0,True))
  c=trace['config'];cfg=types.SimpleNamespace(get_printer=lambda:printer,get_name=lambda:'verify_heater extruder',getfloat=lambda k,default,**kw:{'hysteresis':c['hysteresis'],'max_error':c['maxError'],'heating_gain':c['heatingGain'],'check_gain_time':c['checkGainTime']}[k])
  h=HeaterCheck(cfg);out=[];h.heater=types.SimpleNamespace(get_temp=lambda t:(temp,target))
  for event,temp,target in trace['samples']:
   next_time=float('inf') if fault[0] else h.check_event(event)
   out.append([h.approaching_target,h.starting_approach,h.last_target,h.goal_temp,h.error,None if h.goal_systime==float('inf') else h.goal_systime,fault[0],None if next_time==float('inf') else next_time])
  results.append(out)
 return results
result=run()
for _ in range(3):run()
times=[]
for _ in range(11):
 start=time.perf_counter();run();times.append((time.perf_counter()-start)*1000)
print(json.dumps({'result':result,'times':sorted(times)}))
`;
const dir=mkdtempSync(join(tmpdir(),'anyraid-heater-check-'));let oracle:{result:unknown;times:number[]};
try{const path=join(dir,'input.json');writeFileSync(path,JSON.stringify(traces));const p=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/extras/verify_heater.py',import.meta.url)),path],{encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024});if(p.status!==0)throw new Error(p.stderr||String(p.error));oracle=JSON.parse(p.stdout);}finally{rmSync(dir,{recursive:true,force:true});}
function run(){return traces.map(trace=>{const c=new HeaterCheck(trace.config);return trace.samples.map(([time,temp,target])=>{const next=c.check(time,temp,target),s=c.state;return [s.approaching,s.starting,s.lastTarget,s.goalTemperature,s.error,Number.isFinite(s.goalTime)?s.goalTime:null,s.faulted,Number.isFinite(next)?next:null];});});}
assert.deepEqual(run(),oracle.result);for(let i=0;i<3;i++)run();const times=[];for(let i=0;i<11;i++){const start=performance.now();run();times.push(performance.now()-start);}times.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,traces:traces.length,checks:50000,statesExact:true,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10],speedup:oracle.times[5]/times[5]},null,2));assert.ok(times[5]<=oracle.times[5],'Heater verification regressed against Python');
