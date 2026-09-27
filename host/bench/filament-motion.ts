import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {FilamentMotionState} from '../src/inputs/filament-motion.ts';
const count=200000,samples=11;
// Original Python distance and strict threshold comparison, isolated from reactor IO.
const python=spawnSync(process.env.PYTHON??'/usr/bin/python3',['-c',`import json,time
N=${count}
def run(capture=False):
 limit=7.; hits=0; states=[]
 for i in range(N):
  pos=(i%1000)*.125
  if i%97==0: limit=pos+7.
  present=pos<limit; hits+=present
  if capture: states.append(present)
 return states if capture else hits
times=[]
for i in range(13):
 start=time.perf_counter(); hits=run(); elapsed=(time.perf_counter()-start)*1000
 if i>=2: times.append(elapsed)
print(json.dumps(dict(hits=hits,times=sorted(times),states=run(True))))`],{encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
assert.equal(python.status,0,python.stderr);const reference=JSON.parse(python.stdout),times:number[]=[];
for(let sample=0;sample<samples+2;sample++){
 const sensor=new FilamentMotionState();sensor.pulse(0,0);let hits=0;const start=performance.now();
 for(let i=0;i<count;i++){const position=(i%1000)*.125;if(i%97===0)sensor.pulse(i,position);const present=sensor.check(i,position);if(sample===0)assert.equal(present,reference.states[i]);if(present)hits++;}
 const elapsed=performance.now()-start;assert.equal(hits,reference.hits);if(sample>=2)times.push(elapsed);
}
times.sort((a,b)=>a-b);assert(times[5]<=reference.times[5]*1.5+2);
console.log(JSON.stringify({node:process.version,observations:count,samples,hits:reference.hits,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:reference.times[5],pythonP95Ms:reference.times[10],scope:'Distance policy only; original Python arithmetic; no position reconstruction, transport or pause latency'},null,2));
