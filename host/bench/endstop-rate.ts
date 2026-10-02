import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {endstopRestTime} from '../src/homing/endstop-rate.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
using q=new TrapQueue();const settings={frequency:1e6,timeOffset:0,maxError:0,queueStepTag:5,directionTag:6};
using a=q.createStepper({...settings,oid:1},'corexy+',.01);using b=q.createStepper({...settings,oid:2},'corexy-',.02);
const actuators=[{stepper:a,stepDistance:.01},{stepper:b,stepDistance:.02}];
const cases=Array.from({length:4000},(_,i)=>{const start=[i%31-15,i%43-21,i%19],end=[(i*7)%71-35,(i*11)%79-39,(i*3)%23],speed=1+i%150;return {start,end,speed,actuators:actuators.map(a=>({start:a.stepper.coordinatePosition(start[0],start[1],start[2]),end:a.stepper.coordinatePosition(end[0],end[1],end[2]),stepDistance:a.stepDistance}))};});
const script=String.raw`
import ast,json,math,sys,time
source=ast.parse(open(sys.argv[1]).read())
cls=next(n for n in source.body if isinstance(n,ast.ClassDef) and n.name=='HomingMove')
fn=next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name=='_calc_endstop_rate')
namespace={'math':math};exec(compile(ast.Module(body=[fn],type_ignores=[]),sys.argv[1],'exec'),namespace)
f=namespace['_calc_endstop_rate'];cases=json.load(sys.stdin)
class Tool:
 def get_position(self):return self.start
class Stepper:
 def __init__(self,c,a):self.c=c;self.a=a
 def calc_position_from_coord(self,p):return self.a['start'] if p is self.c['start'] else self.a['end']
 def get_step_dist(self):return self.a['stepDistance']
class Endstop:
 def __init__(self,c):self.steppers=[Stepper(c,a) for a in c['actuators']]
 def get_steppers(self):return self.steppers
class Owner:pass
owner=Owner();owner.toolhead=Tool();prepared=[(c,Endstop(c)) for c in cases]
def run():
 result=[]
 for c,e in prepared:
  owner.toolhead.start=c['start'];result.append(f(owner,e,c['end'],c['speed']))
 return result
samples=[]
for i in range(14):
 start=time.perf_counter();values=run();elapsed=(time.perf_counter()-start)*1000
 if i>=3:samples.append(elapsed)
print(json.dumps({'values':values,'samples':sorted(samples)}))
`;
const reference=JSON.parse(execFileSync('python3',['-c',script,root+'klippy/extras/homing.py'],{input:JSON.stringify(cases),encoding:'utf8',maxBuffer:4*1024*1024})) as {values:number[];samples:number[]};
const samples:number[]=[];let maximum=0;
for(let round=0;round<14;round++){const start=performance.now();const values=cases.map(c=>endstopRestTime(c.start,c.end,c.speed,actuators));const elapsed=performance.now()-start;for(let i=0;i<values.length;i++){const error=Math.abs(values[i]-reference.values[i]);maximum=Math.max(maximum,error);assert.equal(values[i],reference.values[i]);}if(round>=3)samples.push(elapsed);}
samples.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,cases:cases.length,maxAbsoluteError:maximum,samples:11,typescript:{medianMs:samples[5],p95Ms:samples[10]},originalPython:{medianMs:reference.samples[5],p95Ms:reference.samples[10]},scope:'original Python AST rest-rate formula on native-projected fixture coordinates; TS includes native projection calls; Python projection snapshots exclude CFFI cost; no printer I/O'}));assert(samples[5]<100,'4000 native endstop-rate calculations exceed 100ms desktop budget');
