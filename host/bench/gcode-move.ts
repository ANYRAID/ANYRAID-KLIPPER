import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {GCodeMove} from '../src/gcode/move.ts';
import type {Parameters} from '../src/gcode/move.ts';
const commands:{command:string;params:Parameters}[]=[];
for(let i=0;i<1000;i++)commands.push(
 {command:'G90',params:{}},{command:'M82',params:{}},{command:'G1',params:{X:i*.01,Y:i*.003,E:i*.002,F:1200}},
 {command:'SAVE_GCODE_STATE',params:{NAME:'cycle'}},{command:'G91',params:{}},{command:'M83',params:{}},
 {command:'G1',params:{X:.02,E:.001}},{command:'M220',params:{S:50+i%100}},{command:'M221',params:{S:80+i%40}},
 {command:'G92',params:{E:0}},{command:'SET_GCODE_OFFSET',params:{Z_ADJUST:.00001,MOVE:i%2}},
 {command:'RESTORE_GCODE_STATE',params:{NAME:'cycle',MOVE:1,MOVE_SPEED:20}}
);
const python=String.raw`
import ast,sys,json,time,logging
text=open(sys.argv[1]).read();node=next(n for n in ast.parse(text).body if isinstance(n,ast.ClassDef) and n.name=='GCodeMove')
exec(ast.get_source_segment(text,node),globals());commands=json.load(open(sys.argv[2]))
class Command:
 error=ValueError
 def __init__(self,p):self.p=p
 def get_command_parameters(self):return self.p
 def get(self,k,default=None):return self.p.get(k,default)
 def get_float(self,k,default=None,above=None):
  v=self.p.get(k,default)
  if v is None:return None
  v=float(v)
  if above is not None and v<=above:raise ValueError(k)
  return v
 def get_int(self,k,default=0):return int(self.p.get(k,default))
def run(capture=False):
 g=GCodeMove.__new__(GCodeMove);g.absolute_coord=g.allow_absolute_extrude=True
 g.base_position=[0.,0.,0.,0.];g.last_position=[0.,0.,0.,0.];g.homing_position=[0.,0.,0.,0.]
 g.axis_map={'X':0,'Y':1,'Z':2,'E':3};g.speed=25.;g.speed_factor=1./60.;g.extrude_factor=1.;g.saved_states={}
 moves=[];g.move_with_transform=lambda p,speed:moves.append([list(p),speed])
 states=[]
 for c in commands:
  getattr(g,'cmd_'+c['command'])(Command(c['params']))
  if capture:states.append([g.absolute_coord,g.allow_absolute_extrude,list(g.base_position),list(g.last_position),list(g.homing_position),g.speed,g.speed_factor,g.extrude_factor])
 return {'states':states,'moves':moves}
result=run(True)
for _ in range(3):run()
times=[]
for _ in range(11):
 start=time.perf_counter();run();times.append((time.perf_counter()-start)*1000)
print(json.dumps({'result':result,'times':sorted(times)}))
`;
const dir=mkdtempSync(join(tmpdir(),'anyraid-gcode-'));let oracle;
try {
 const path=join(dir,'commands.json');writeFileSync(path,JSON.stringify(commands));
 const p=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/extras/gcode_move.py',import.meta.url)),path],{encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024});
 if(p.status!==0)throw new Error(p.stderr||String(p.error));oracle=JSON.parse(p.stdout);
}finally{rmSync(dir,{recursive:true,force:true});}
function run(capture=false) {
 const moves:[number[],number][]=[],states:unknown[]=[];let position=[0,0,0,0];
 const engine=new GCodeMove({position:()=>position,move:(p,speed)=>{position=[...p];moves.push([position,speed]);}});
 for(const c of commands){engine.execute(c.command,c.params);if(capture){const s=engine.state;states.push([s.absoluteCoordinates,s.absoluteExtrude,s.base,s.position,s.homing,s.speed,s.speedFactor,s.extrudeFactor]);}}
 return {moves,states};
}
assert.deepEqual(run(true),oracle.result);
for(let i=0;i<3;i++)run();const times=[];
for(let i=0;i<11;i++){const start=performance.now();run();times.push(performance.now()-start);}times.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,commands:commands.length,statesExact:true,moves:oracle.result.moves.length,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10],speedup:oracle.times[5]/times[5]},null,2));
assert.ok(times[5]<=oracle.times[5],'Coordinate dispatch regressed against Python');
