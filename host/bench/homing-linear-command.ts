import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {homingRetract} from '../src/homing/linear-command.ts';
import {linearHomingFixture} from '../test/helpers/linear-homing.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
const fixtures=Array.from({length:4000},(_,i)=>{
 const axis=i%3,home=[(i%13)*.37,(i%17)*.23,(i%23)*.11,7,9],force=[...home];force[axis]+=(i%2?1:-1)*(1+i%377)*1.13;
 return {force,home,distance:(i%401+1)*.19};
});
const expected=JSON.parse(execFileSync('python3',['-c',String.raw`
import ast,math,json,sys,types
source=ast.parse(open('klippy/extras/homing.py').read())
cls=next(n for n in source.body if isinstance(n,ast.ClassDef) and n.name=='Homing')
fn=next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name=='_retract_move')
scope={'math':math};exec(compile(ast.Module(body=[fn],type_ignores=[]),'reference','exec'),scope)
results=[]
for f in json.load(sys.stdin):
 out={}
 port=types.SimpleNamespace(move=lambda p,s:out.update(retract=p),set_position=lambda p:out.update(start=p))
 self=types.SimpleNamespace(_fill_coord=lambda p:list(p),toolhead=port)
 scope['_retract_move'](self,types.SimpleNamespace(retract_dist=f['distance'],retract_speed=20),f['force'],f['home'])
 results.append(out)
print(json.dumps(results))
`],{input:JSON.stringify(fixtures),encoding:'utf8',maxBuffer:8*1024*1024})) as ReturnType<typeof homingRetract>[];
let maxError=0;for(const [i,f] of fixtures.entries()){
 const got=homingRetract(f.force,f.home,f.distance);
 for(const key of ['retract','start'] as const)for(let axis=0;axis<got[key].length;axis++){const error=Math.abs(got[key][axis]-expected[i][key][axis]);maxError=Math.max(error,maxError);assert(error<=1e-12);}
}
const samples:number[][]=[[],[]],iterations=100;
for(let round=0;round<14;round++)for(const dispatched of round%2?[1,0]:[0,1]){
 const f=linearHomingFixture(),d=new GCodeDispatch({output(){},shutdown:()=>assert.fail()});f.command.register(d);d.setReady(true);
 const start=performance.now();for(let i=0;i<iterations;i++){if(dispatched)await d.execute('G28 X');else await f.command.home([0],new AbortController().signal);assert.equal(f.kin.status.homedAxes,'x');f.events.length=0;}
 if(round>=3)samples[dispatched].push(performance.now()-start);assert.equal(f.stops,0);
}
for(const s of samples)s.sort((a,b)=>a-b);const stats=(s:number[])=>({medianMs:s[5],p95Ms:s[10]});
console.log(JSON.stringify({node:process.version,precisionFixtures:fixtures.length,maxCoordinateError:maxError,iterations,direct:stats(samples[0]),gcode:stats(samples[1]),scope:'two-pass command orchestration with simulated motion driver and exact integer history; excludes serial, physical motion and printer speed'}));
assert(samples[1][5]/iterations<1,'G28 command orchestration exceeds 1ms desktop median budget');
assert((samples[1][5]-samples[0][5])/iterations<.25,'G-code integration exceeds 0.25ms additional median budget');
