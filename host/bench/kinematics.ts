import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {LinearKinematics,KinematicError,type Axis,type LinearConfig} from '../src/kinematics/linear.ts';
import {Move,motionLimits} from '../src/motion/lookahead.ts';
let seed=12345;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
const points=Array.from({length:10000},(_,i)=>{
 const start=[rand()*200,rand()*200,rand()*250,0],end=[...start];
 for(let a=0;a<4;a++)if(i%(a+2)!==0)end[a]+=(rand()-.5)*60;
 return {start,end,speed:1+rand()*400,mask:i%9===0?i%8:7};
});
const config:LinearConfig={kind:'cartesian',ranges:[[0,200],[0,200],[0,250]],maxVelocity:300,maxAccel:3000,maxZVelocity:10,maxZAccel:100};
const python=String.raw`
import ast,sys,json,time,math,types,pathlib
root=pathlib.Path(sys.argv[1]);data=json.load(open(sys.argv[2]))
for file,name in [('toolhead.py','Move'),('kinematics/cartesian.py','CartKinematics'),('kinematics/corexy.py','CoreXYKinematics')]:
 text=(root/file).read_text();node=next(n for n in ast.parse(text).body if isinstance(n,ast.ClassDef) and n.name==name);exec(ast.get_source_segment(text,node),globals())
toolhead=types.SimpleNamespace(max_velocity=300.,max_accel=3000.,junction_deviation=25*(math.sqrt(2)-1)/3000,mcr_pseudo_accel=1500.,printer=types.SimpleNamespace(command_error=ValueError))
def run(cls):
 k=cls.__new__(cls);k.max_z_velocity=10.;k.max_z_accel=100.;out=[]
 for p in data:
  k.limits=[(0.,250. if a==2 else 200.) if p['mask']&(1<<a) else (1.,-1.) for a in range(3)]
  m=Move(toolhead,p['start'],p['end'],p['speed']);error=None
  try:k.check_move(m)
  except ValueError as e:error='unhomed' if str(e).startswith('Must home') else 'out_of_range'
  out.append([error,m.max_cruise_v2,m.accel,m.min_move_t,m.delta_v2,m.mcr_delta_v2])
 return out
results=[run(CartKinematics),run(CoreXYKinematics)]
for _ in range(3):run(CartKinematics)
times=[]
for _ in range(11):
 start=time.perf_counter();run(CartKinematics);times.append((time.perf_counter()-start)*1000)
print(json.dumps({'results':results,'times':sorted(times)}))
`;
const dir=mkdtempSync(join(tmpdir(),'anyraid-kinematics-'));let oracle:{results:([string|null,number,number,number,number,number])[][];times:number[]};
try {
 const input=join(dir,'input.json');writeFileSync(input,JSON.stringify(points));
 const p=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy',import.meta.url)),input],{encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});
 if(p.status!==0)throw new Error(p.stderr||String(p.error));oracle=JSON.parse(p.stdout);
}finally{rmSync(dir,{recursive:true,force:true});}
const limits=motionLimits(300,3000);
function run(kind:'cartesian'|'corexy') {
 const k=new LinearKinematics({...config,kind});
 return points.map(p=>{
  k.clearHoming([0,1,2]);k.markHomed(([0,1,2] as Axis[]).filter(a=>p.mask&(1<<a)));
  const m=new Move(limits,p.start,p.end,p.speed);let error:string|null=null;
  try{k.check(m);}catch(e){if(!(e instanceof KinematicError))throw e;error=e.code;}
  return [error,m.maxCruiseV2,m.accel,m.minMoveT,m.deltaV2,m.mcrDeltaV2];
 });
}
let maxSpeedError=0,maxSquaredRelativeError=0;
for(const [index,kind] of (['cartesian','corexy'] as const).entries()) {
 const actual=run(kind),expected=oracle.results[index];
 for(let i=0;i<actual.length;i++) {
  assert.equal(actual[i][0],expected[i][0]);assert.deepEqual(actual[i].slice(2),expected[i].slice(2));
  const a=actual[i][1] as number,b=expected[i][1] as number;
  const relative=Math.abs(a-b)/Math.max(1,Math.abs(b));maxSquaredRelativeError=Math.max(maxSquaredRelativeError,relative);
  maxSpeedError=Math.max(maxSpeedError,Math.abs(Math.sqrt(a)-Math.sqrt(b)));
  // CPython pow(v,2) may differ from V8 v*v by one rounding unit.
  assert.ok(relative<=Number.EPSILON,'Squared speed exceeds one relative rounding unit');
 }
}
assert.ok(maxSpeedError<=1e-12);
for(let i=0;i<3;i++)run('cartesian');const times=[];
for(let i=0;i<11;i++){const start=performance.now();run('cartesian');times.push(performance.now()-start);}times.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,cases:points.length*2,decisionsExact:true,otherFieldsExact:true,maxSpeedError,maxSquaredRelativeError,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10],speedup:oracle.times[5]/times[5]},null,2));
assert.ok(times[5]<=oracle.times[5],'Linear kinematics regressed against Python');
