import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {cpus} from 'node:os';
import {StepperPosition} from '../src/motion/stepper-position.ts';
const count=10000,times:number[]=[],actual:unknown[]=[];
for(let run=0;run<14;run++){const p=new StepperPosition(40,3200),start=performance.now();for(let i=0;i<count;i++){const commanded=(i%2001-1000)*.0125+(i%3-1)*.00625;if(i%100===0){p.align(BigInt(i-5000),commanded);p.setRotationDistance(40+(i%7)*.1,commanded);}const steps=p.mcuPosition(commanded),position=p.commandedPosition(steps);if(run===0)actual.push([String(steps),position]);}if(run>=3)times.push(performance.now()-start);}times.sort((a,b)=>a-b);
const python=String.raw`
import ast,sys,time,json,textwrap,types
source=open(sys.argv[1]).read();cls=next(n for n in ast.parse(source).body if isinstance(n,ast.ClassDef) and n.name=='MCU_stepper');namespace={}
for name in ['get_mcu_position','_set_mcu_position','mcu_to_commanded_position','set_rotation_distance']:
 node=next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name==name);exec(textwrap.dedent(ast.get_source_segment(source,node)),globals(),namespace)
P=type('P',(),namespace);samples=[];expected=[]
for run in range(14):
 p=P();p._rotation_dist=40.;p._steps_per_rotation=3200.;p._step_dist=40./3200.;p._mcu_position_offset=0.;p._trapq=None;p.set_trapq=lambda q:None;p.get_commanded_position=lambda:p.commanded
 start=time.perf_counter()
 for i in range(10000):
  p.commanded=(i%2001-1000)*.0125+(i%3-1)*.00625
  if i%100==0:p._set_mcu_position(i-5000);p.set_rotation_distance(40+(i%7)*.1)
  steps=p.get_mcu_position();position=p.mcu_to_commanded_position(steps)
  if run==0:expected.append([str(steps),position])
 if run>=3:samples.append((time.perf_counter()-start)*1000)
print(json.dumps({'results':expected,'samples':sorted(samples),'python':sys.version.split()[0]}))
`;
const p=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/stepper.py',import.meta.url))],{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});assert.equal(p.status,0,p.stderr||String(p.error));const ref=JSON.parse(p.stdout);assert.deepEqual(actual,ref.results);
console.log(JSON.stringify({node:process.version,python:ref.python,cpu:cpus()[0].model,samples:count,identical:true,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:ref.samples[5],pythonP95Ms:ref.samples[10],scope:'Host coordinate/step conversion including periodic origin and rotation-distance updates. Native synchronization and hardware motion are not timed.'},null,2));
