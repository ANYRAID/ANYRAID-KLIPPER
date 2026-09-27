import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {ControllerFanState} from '../src/thermal/controller-fan.ts';
const count=20000,python=String.raw`
import sys,time,json,types
ns={};exec(open(sys.argv[1]).read().replace('from . import fan',''),ns)
def run():
 out=[];f=ns['ControllerFan'].__new__(ns['ControllerFan']);f.stepper_names=[];f.fan_speed=1.;f.idle_speed=.3;f.idle_timeout=30;f.last_on=30;f.last_speed=0.
 f.fan=types.SimpleNamespace(set_speed=lambda speed:out.append(speed))
 f.heaters=[types.SimpleNamespace(get_temp=lambda eventtime:(25,200 if eventtime%100<30 else 0))]
 for i in range(20000):f.callback(i)
 return out
times=[]
for i in range(14):
 start=time.perf_counter();out=run();elapsed=(time.perf_counter()-start)*1000
 if i>=3:times.append(elapsed)
print(json.dumps({'transitions':out,'times':sorted(times)}))
`;
const result=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/extras/controller_fan.py',import.meta.url))],{encoding:'utf8',timeout:60000});if(result.status!==0)throw new Error(result.stderr||String(result.error));const reference=JSON.parse(result.stdout),times:number[]=[];
for(let sample=0;sample<14;sample++){
 const state=new ControllerFanState({heaters:['extruder'],steppers:[],speed:1,idleSpeed:.3,idleTimeout:30}),out:number[]=[];let last=0;const begin=performance.now();
 for(let i=0;i<count;i++){const speed=state.speed(i,i%100<30);if(speed!==last){out.push(speed);last=speed;}}
 const elapsed=performance.now()-begin;assert.deepEqual(out,reference.transitions);if(sample>=3)times.push(elapsed);
}
times.sort((a,b)=>a-b);assert(times[5]<=reference.times[5]*1.5+2);
console.log(JSON.stringify({node:process.version,polls:count,exactTransitions:reference.transitions.length,samples:11,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:reference.times[5],pythonP95Ms:reference.times[10],scope:'One-second synthetic cadence, original Python callback versus TS policy; excludes serial IO and physical motor/fan timing'}));
