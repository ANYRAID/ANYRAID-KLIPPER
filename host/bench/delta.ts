import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {DeltaKinematics,type DeltaConfig} from '../src/kinematics/delta.ts';
import {Move,motionLimits} from '../src/motion/lookahead.ts';
import {KinematicError} from '../src/kinematics/linear.ts';
import type {Vec3} from '../src/math/mathutil.ts';
const config:DeltaConfig={radius:100,printRadius:150,arms:[250,250,250],angles:[210,330,90],endstops:[300,300,300],stepDistances:[.01,.01,.01],minimumZ:0,maxVelocity:300,maxAccel:3000,maxZVelocity:20,maxZAccel:200};
if(process.env.DELTA_ASYMMETRIC){config.arms=[249,251,250.5];config.angles=[209.9,330.2,90];config.endstops=[300,299.8,300.4];config.stepDistances=[.01,.0125,.008];}
let seed=24680;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
const points=Array.from({length:10000},(_,i)=>{const r=rand()*160,a=rand()*Math.PI*2;return {end:[Math.cos(a)*r,Math.sin(a)*r,i%3?rand()*330-10:10,0],speed:10+rand()*350,home:i%37!==0};});
const coords:Vec3[]=Array.from({length:1000},()=>[rand()*100-50,rand()*100-50,rand()*250]);
const python=String.raw`
import sys,ast,json,math,time,types,pathlib,logging
root=pathlib.Path(sys.argv[1]);sys.path.insert(0,str(root));import mathutil
data=json.load(open(sys.argv[2]));cfg=data['config']
for file,names in [('toolhead.py',['Move']),('kinematics/delta.py',['DeltaKinematics','DeltaCalibration'])]:
 text=(root/file).read_text()
 for name in names:
  node=next(n for n in ast.parse(text).body if isinstance(n,ast.ClassDef) and n.name==name);exec(ast.get_source_segment(text,node),globals())
SLOW_RATIO=3.
class Section:
 def __init__(self,i):self.i=i
 def getfloat(self,key,default=None,**kw):return {'arm_length':cfg['arms'][self.i],'angle':cfg['angles'][self.i]}.get(key,default)
class Config:
 def getsection(self,name):return Section('abc'.index(name[-1]))
 def getfloat(self,key,default=None,**kw):return {'delta_radius':100.,'print_radius':150.,'max_z_velocity':20.,'max_z_accel':200.,'minimum_z_position':0.}.get(key,default)
class Rail:
 def __init__(self,section,**kw):self.i=section.i
 def get_homing_info(self):return types.SimpleNamespace(position_endstop=cfg['endstops'][self.i])
 def get_steppers(self):return [types.SimpleNamespace(set_trapq=lambda q:None,get_step_dist=lambda:cfg['stepDistances'][self.i])]
 def setup_itersolve(self,*a):pass
 def set_position(self,*a):pass
stepper=types.SimpleNamespace(LookupMultiRail=Rail)
toolhead=types.SimpleNamespace(max_velocity=300.,max_accel=3000.,junction_deviation=25*(math.sqrt(2)-1)/3000,mcr_pseudo_accel=1500.,printer=types.SimpleNamespace(command_error=ValueError),get_max_velocity=lambda:(300.,3000.),Coord=tuple,get_trapq=lambda:None)
def run():
 k=DeltaKinematics(toolhead,Config());out=[]
 for p in data['points']:
  k.clear_homing_state('xyz');k.set_position([0.,0.,10.], 'xyz' if p['home'] else '')
  m=Move(toolhead,[0.,0.,10.,0.],p['end'],p['speed']);error=None
  try:k.check_move(m)
  except ValueError as e:error='unhomed' if str(e).startswith('Must home') else 'out_of_range'
  out.append([error,m.max_cruise_v2,m.accel,m.min_move_t,m.delta_v2,m.mcr_delta_v2,k.limit_xy2])
 return out
k=DeltaKinematics(toolhead,Config());cal=DeltaCalibration(100.,cfg['angles'],cfg['arms'],cfg['endstops'],cfg['stepDistances'])
geometry=[[cal.calc_stable_position(p),cal.get_position_from_stable(cal.calc_stable_position(p))] for p in data['coords']]
result=run()
for _ in range(3):run()
times=[]
for _ in range(11):
 start=time.perf_counter();run();times.append((time.perf_counter()-start)*1000)
print(json.dumps({'result':result,'geometry':geometry,'derived':[list(k.home_position),k.limit_z,k.slow_xy2,k.very_slow_xy2,k.max_xy2],'times':sorted(times)}))
`;
const dir=mkdtempSync(join(tmpdir(),'anyraid-delta-'));let oracle:{result:(string|number|null)[][];geometry:number[][][];derived:unknown[];times:number[]};
try {
 const input=join(dir,'input.json');writeFileSync(input,JSON.stringify({points,coords,config}));
 const p=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy',import.meta.url)),input],{encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});
 if(p.status!==0)throw new Error(p.stderr||String(p.error));oracle=JSON.parse(p.stdout);
}finally{rmSync(dir,{recursive:true,force:true});}
const limits=motionLimits(300,3000);
function run(){const k=new DeltaKinematics(config);return points.map(p=>{k.clearHoming();k.resetPosition(p.home?'xyz':'');const m=new Move(limits,[0,0,10,0],p.end,p.speed);let error:string|null=null;try{k.check(m);}catch(e){if(!(e instanceof KinematicError))throw e;error=e.code;}return [error,m.maxCruiseV2,m.accel,m.minMoveT,m.deltaV2,m.mcrDeltaV2,k.thresholds.cachedXY2];});}
let maxRelative=0,maxPositionError=0;
function compare(actual:unknown,expected:unknown):void {
 if(Array.isArray(actual)&&Array.isArray(expected)){assert.equal(actual.length,expected.length);actual.forEach((v,i)=>compare(v,expected[i]));return;}
 if(typeof actual==='number'&&typeof expected==='number'){const relative=Math.abs(actual-expected)/Math.max(1,Math.abs(expected));maxRelative=Math.max(maxRelative,relative);assert.ok(relative<1e-12,`${actual} != ${expected}`);return;}
 assert.equal(actual,expected);
}
compare(run(),oracle.result);
const k=new DeltaKinematics(config),t=k.thresholds;compare([k.homePosition,k.status.coneStartZ,t.slowXY2,t.verySlowXY2,t.maxXY2],oracle.derived);
coords.forEach((p,i)=>{const stable=k.stablePosition(p),restored=k.positionFromStable(stable);compare([stable,restored],oracle.geometry[i]);for(let j=0;j<3;j++){maxPositionError=Math.max(maxPositionError,Math.abs(restored[j]-oracle.geometry[i][1][j]));assert.ok(Math.abs(restored[j]-p[j])<1e-10);}});
for(let i=0;i<3;i++)run();const times=[];for(let i=0;i<11;i++){const start=performance.now();run();times.push(performance.now()-start);}times.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,asymmetric:!!process.env.DELTA_ASYMMETRIC,moves:points.length,geometry:coords.length,decisionsExact:true,maxRelative,maxPositionError,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10],speedup:oracle.times[5]/times[5]},null,2));
assert.ok(times[5]<=oracle.times[5],'Delta admission regressed against Python');
