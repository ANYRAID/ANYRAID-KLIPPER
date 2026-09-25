import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {pressureAdvanceCommand} from '../src/gcode/pressure-advance.ts';
import {fixed6} from '../src/math/python-decimal.ts';
const commands:Record<string,string>[]=[{}, {ADVANCE:'.1'}, {ADVANCE:'.1'}, {ADVANCE:'0'}, {SMOOTH_TIME:'.1'}, {ADVANCE:'.2'}, {SMOOTH_TIME:'0'}, {ADVANCE:'.3'}, {SMOOTH_TIME:'.2'}, {ADVANCE:'0'}, {ADVANCE:'０.０５',SMOOTH_TIME:'.04'}],iterations=100000;
const python=String.raw`
import ast,json,sys,time,types
text=open(sys.argv[1]).read();node=next(n for n in ast.parse(text).body if isinstance(n,ast.ClassDef) and n.name=='ExtruderStepper');exec(ast.get_source_segment(text,node),globals());commands=json.loads(sys.argv[2]);iterations=int(sys.argv[3]);events=[]
class Lib:
 def extruder_set_pressure_advance(self,sk,t,a,s):pass
chelper=types.SimpleNamespace(get_ffi=lambda:(None,Lib()))
class Printer:
 def lookup_object(self,name):return self
 def flush_step_generation(self):events.append('window-change')
 def check_step_generation_scan_windows(self):pass
 def register_lookahead_callback(self,callback):events.append('same-window');callback(42.)
 def set_rollover_info(self,name,message):pass
class Command:
 def __init__(self,p):self.p=p;self.message=''
 def get_float(self,k,default,minval=None,maxval=None):
  v=float(self.p[k]) if k in self.p else default
  if minval is not None and v<minval or maxval is not None and v>maxval:raise ValueError(k)
  return v
 def respond_info(self,msg,log=False):self.message=msg
p=Printer();e=ExtruderStepper.__new__(ExtruderStepper);e.printer=p;e.name='extruder';e.sk_extruder=None;e.pressure_advance=.05;e.pressure_advance_smooth_time=.04
objects=[Command(c) for c in commands];states=[]
for c in objects:
 e.cmd_SET_PRESSURE_ADVANCE(c);states.append([e.pressure_advance,e.pressure_advance_smooth_time,events.pop(),c.message])
times=[];checksum=0.
for run in range(14):
 e.pressure_advance=.05;e.pressure_advance_smooth_time=.04;start=time.perf_counter()
 for i in range(iterations):
  e.cmd_SET_PRESSURE_ADVANCE(objects[i%len(objects)]);checksum+=e.pressure_advance;events.clear()
 if run>=3:times.append((time.perf_counter()-start)*1e6/iterations)
print(json.dumps({'states':states,'times':sorted(times),'checksum':checksum}))
`;
const p=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/kinematics/extruder.py',import.meta.url)),JSON.stringify(commands),String(iterations)],{encoding:'utf8',timeout:60000});if(p.status!==0)throw Error(p.stderr||String(p.error));const reference=JSON.parse(p.stdout);
let state={advance:.05,smoothTime:.04};const format=(s:typeof state)=>`pressure_advance: ${fixed6(s.advance)}\npressure_advance_smooth_time: ${fixed6(s.smoothTime)}`;
assert.deepEqual(commands.map(c=>{const change=pressureAdvanceCommand(c,state);state={...change.next};return [state.advance,state.smoothTime,change.kind,format(state)];}),reference.states);
const times:number[]=[];let checksum=0;for(let run=0;run<14;run++){state={advance:.05,smoothTime:.04};const start=performance.now();for(let i=0;i<iterations;i++){const change=pressureAdvanceCommand(commands[i%commands.length],state);state={...change.next};format(state);checksum+=state.advance;}if(run>=3)times.push((performance.now()-start)*1000/iterations);}times.sort((a,b)=>a-b);assert.equal(checksum,reference.checksum);
const limits={medianRatio:1.25,medianSlackUs:1,p95Ratio:1.5,p95SlackUs:2};assert(times[5]<=reference.times[5]*limits.medianRatio+limits.medianSlackUs);assert(times[10]<=reference.times[10]*limits.p95Ratio+limits.p95SlackUs);
console.log(JSON.stringify({node:process.version,cases:commands.length,statesAndWindowDecisionsExact:true,iterations,warmup:3,samples:11,nodeMedianUs:times[5],pythonMedianUs:reference.times[5],nodeP95Us:times[10],pythonP95Us:reference.times[10],limits,scope:'Parameter conversion, effective-window classification, state values and response formatting. Does not measure native scheduling, barriers, UART or real printing.'},null,2));
