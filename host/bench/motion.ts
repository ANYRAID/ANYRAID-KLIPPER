// Differential trajectory oracle using the repository's unchanged Move/LookAheadQueue.
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {Move,LookAheadQueue,motionLimits} from '../src/motion/lookahead.ts';
import {ExtrusionGuard} from '../src/motion/extrusion.ts';
let seed=0x20304050;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
const points:{end:number[];speed:number}[]=[];
let previous=[0,0,0,0];
for(let i=0;i<10000;i++) {
  const length=10**(-4+random()*5),angle=i%17===0?Math.PI*random()*2:i*.0001;
  const end=i%37===0 ? [previous[0],previous[1],previous[2],previous[3]+random()*2-1] : [previous[0]+Math.cos(angle)*length,previous[1]+Math.sin(angle)*length,previous[2]+(random()-.5)*length*.01,previous[3]+length*.03];
  points.push({end,speed:1+random()*400});previous=end;
}
const configs:{ratio:number;corner:number;extra:number|null;extrusion?:boolean}[]=[{ratio:0,corner:5,extra:null},{ratio:.5,corner:5,extra:null},{ratio:.95,corner:0,extra:null},{ratio:.5,corner:5,extra:9},{ratio:.5,corner:5,extra:null,extrusion:true}];
const python=String.raw`
import ast,json,sys,math,time,types,pathlib,logging
text=open(sys.argv[1]).read();tree=ast.parse(text)
for name in ['Move','LookAheadQueue']:
 node=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name==name)
 exec(ast.get_source_segment(text,node),globals())
LOOKAHEAD_FLUSH_TIME=.150
extruder_text=(pathlib.Path(sys.argv[1]).parent/'kinematics/extruder.py').read_text()
extruder_node=next(n for n in ast.parse(extruder_text).body if isinstance(n,ast.ClassDef) and n.name=='PrinterExtruder')
exec(ast.get_source_segment(extruder_text,extruder_node),globals())
data=json.load(open(sys.argv[2]))
def run(config):
 toolhead=types.SimpleNamespace(max_velocity=300.,max_accel=3000.,junction_deviation=config['corner']**2*(math.sqrt(2)-1)/3000.,mcr_pseudo_accel=3000.*(1-config['ratio']),extra_axes=[])
 if config['extra'] is not None:toolhead.extra_axes=[types.SimpleNamespace(calc_junction=lambda *args:config['extra'])]
 if config.get('extrusion'):
  guard=PrinterExtruder.__new__(PrinterExtruder)
  guard.heater=types.SimpleNamespace(can_extrude=True);guard.printer=types.SimpleNamespace(command_error=ValueError)
  guard.nozzle_diameter=.4;guard.filament_area=math.pi*(1.75*.5)**2;guard.max_extrude_ratio=.64/guard.filament_area
  guard.max_e_velocity=25.;guard.max_e_accel=500.;guard.max_e_dist=50.;guard.instant_corner_v=1.
  toolhead.extra_axes=[guard]
 q=LookAheadQueue();start=[0.,0.,0.,0.];out=[];batches=[]
 for p in data['points']:
  m=Move(toolhead,start,p['end'],p['speed']);start=list(m.end_pos)
  if not m.move_d:continue
  if config.get('extrusion'):
   if m.axes_d[3]:guard.check_move(m,3)
  elif not m.is_kinematic_move:m.limit_speed(25.,500.)
  if q.add_move(m):
   batch=q.flush(lazy=True);batches.append(len(batch));out.extend(batch)
 batch=q.flush();batches.append(len(batch));out.extend(batch)
 return out,batches
results=[]
for config in data['configs']:
 moves,batches=run(config)
 results.append({'batches':batches,'moves':[[m.move_d,m.start_v,m.cruise_v,m.end_v,m.accel_t,m.cruise_t,m.decel_t] for m in moves]})
for _ in range(3):run(data['configs'][-1])
times=[]
for _ in range(11):
 t=time.perf_counter();moves,_=run(data['configs'][-1]);times.append((time.perf_counter()-t)*1000)
print(json.dumps({'results':results,'times':sorted(times),'python':sys.version}))
`;
const dir=mkdtempSync(join(tmpdir(),'anyraid-motion-'));
let oracle;
try {
  const path=join(dir,'input.json');writeFileSync(path,JSON.stringify({points,configs}));
  const run=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/toolhead.py',import.meta.url)),path],{encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024});
  if(run.status!==0) throw new Error(run.stderr||String(run.error));oracle=JSON.parse(run.stdout);
} finally {rmSync(dir,{recursive:true,force:true});}
function run(config:typeof configs[number]):{moves:Move[];batches:number[]} {
  const limits=motionLimits(300,3000,config.corner,config.ratio);
  if(config.extra!==null) limits.extraAxes=[()=>config.extra!];
  const guard=config.extrusion ? new ExtrusionGuard({nozzleDiameter:.4,filamentDiameter:1.75,maxCrossSection:.64,maxVelocity:25,maxAccel:500,maxDistance:50,instantCornerVelocity:1}) : undefined;
  if(guard) limits.extraAxes=[(a,b,index)=>guard.junction(a,b,index)];
  const queue=new LookAheadQueue(),moves:Move[]=[],batches:number[]=[];
  let start=[0,0,0,0];
  for(const point of points) {
    const move=new Move(limits,start,point.end,point.speed);start=move.endPos;
    if(guard) guard.check(move,3,true);
    else if(!move.isKinematic) move.limitSpeed(25,500);
    if(queue.add(move)) {const batch=queue.flush(true);batches.push(batch.length);moves.push(...batch);}
  }
  const batch=queue.flush();batches.push(batch.length);moves.push(...batch);return {moves,batches};
}
let maxDistanceError=0,maxVelocityError=0,maxTimeError=0,maxIntegratedError=0;
for(let c=0;c<configs.length;c++) {
  const output=run(configs[c]);assert.deepEqual(output.batches,oracle.results[c].batches);
  assert.equal(output.moves.length,oracle.results[c].moves.length);
  output.moves.forEach((move,i)=>{
    const p=move.profile!,values=[move.distance,p.startV,p.cruiseV,p.endV,p.accelT,p.cruiseT,p.decelT];
    values.forEach((v,j)=>{
      const reference=oracle.results[c].moves[i][j],delta=Math.abs(v-reference);
      assert.ok(delta <= (j>=4?1e-12:1e-9)+Math.abs(reference)*1e-11,`config=${c} move=${i} field=${j}: ${v} vs ${reference}`);
      if(j===0) maxDistanceError=Math.max(maxDistanceError,delta);
      else if(j<4) maxVelocityError=Math.max(maxVelocityError,delta);
      else maxTimeError=Math.max(maxTimeError,delta);
    });
    const integrated=(p.startV+p.cruiseV)*.5*p.accelT+p.cruiseV*p.cruiseT+(p.endV+p.cruiseV)*.5*p.decelT;
    maxIntegratedError=Math.max(maxIntegratedError,Math.abs(integrated-move.distance));
  });
}
for(let i=0;i<3;i++) run(configs.at(-1)!);
const times=[];
for(let i=0;i<11;i++) {const start=performance.now();run(configs.at(-1)!);times.push(performance.now()-start);}
times.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,python:oracle.python,cpu:cpus()[0].model,comparedMoves:points.length*configs.length,maxDistanceError,maxVelocityError,maxTimeError,maxIntegratedError,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10],speedup:oracle.times[5]/times[5]},null,2));
assert.ok(times[5]<=oracle.times[5],'Lookahead planning regressed against Python');
