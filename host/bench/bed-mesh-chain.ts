import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {BedMesh} from '../src/motion/bed-mesh.ts';
import {BedMeshFade} from '../src/motion/bed-mesh-fade.ts';
import {BedMeshMovePort} from '../src/motion/bed-mesh-port.ts';
import {motionLimits} from '../src/motion/lookahead.ts';
import {GCodeMove,type Parameters} from '../src/gcode/move.ts';
const params={min_x:0,max_x:220,min_y:0,max_y:300,x_count:5,y_count:5,mesh_x_pps:2,mesh_y_pps:3,algo:'bicubic' as const,tension:.2};
const matrix=Array.from({length:5},(_,y)=>Array.from({length:5},(_,x)=>Math.sin(x*.7)*.3+(Math.cos(y*.4)-1)*.2));
const commands:{command:string;params:Parameters}[]=[];
for(let i=0;i<160;i++){commands.push({command:'G90',params:{}},{command:'G1',params:{X:(i*67)%250-10,Y:(i*31)%340-10,Z:[0,.8,1,1.2,5,9.9,10,12][i%8],E:i*.01,F:6000}});if(i%13===0)commands.push({command:'G91',params:{}},{command:'G1',params:{X:.01,Y:-.02,E:.001}},{command:'G90',params:{}});}
const configs=[{start:1,end:0,target:0,toolOffset:0},{start:1,end:10,target:0,toolOffset:0},{start:1,end:10,target:.05,toolOffset:2}];
const source=String.raw`
import ast,sys,json,math,logging,time,types,pathlib
root=pathlib.Path(sys.argv[1]);ns=dict(math=math,logging=logging,LOOKAHEAD_FLUSH_TIME=.150,BedMeshError=RuntimeError)
for path,names in [('klippy/toolhead.py',['Move','LookAheadQueue']),('klippy/extras/bed_mesh.py',['BedMesh','ZMesh','MoveSplitter','constrain','lerp','isclose']),('klippy/extras/gcode_move.py',['GCodeMove'])]:
 tree=ast.parse((root/path).read_text());nodes=[n for n in tree.body if isinstance(n,(ast.ClassDef,ast.FunctionDef)) and n.name in names];exec(compile(ast.Module(body=nodes,type_ignores=[]),path,'exec'),ns)
ns['ZMesh'].print_mesh=lambda *a:None
r=json.load(sys.stdin)
class Config:
 def getfloat(self,name,default,**kwargs):return default
class Command:
 error=ValueError
 def __init__(self,p):self.p=p
 def get_command_parameters(self):return self.p
class Tool:
 def __init__(self):
  self.max_velocity=300.;self.max_accel=3000.;self.junction_deviation=25*(math.sqrt(2)-1)/3000.;self.mcr_pseudo_accel=1500.;self.extra_axes=[];self.position=[0.,0.,0.,0.];self.queue=ns['LookAheadQueue']()
 def get_position(self):return list(self.position)
 def move(self,p,speed):
  m=ns['Move'](self,self.position,p,speed);self.position=list(m.end_pos)
  if m.move_d:self.queue.add_move(m)
def run(c,capture=False):
 mesh=ns['ZMesh'](r['params'],'oracle');mesh.build_mesh(r['matrix']);tool=Tool();b=ns['BedMesh'].__new__(ns['BedMesh']);b.z_mesh=mesh;b.toolhead=tool;b.fade_start=c['start'];b.fade_end=c['end'];b.fade_dist=c['end']-c['start'];b.fade_target=c['target'] if b.fade_dist>0 else 0.;b.tool_offset=c['toolOffset'];b.log_fade_complete=False;b.last_position=[0.,0.,0.,0.]
 if b.fade_dist<=0:b.fade_start=b.fade_end=b.FADE_DISABLE
 b.splitter=ns['MoveSplitter'](Config(),types.SimpleNamespace(error=ValueError));b.splitter.initialize(mesh,b.fade_target)
 g=ns['GCodeMove'].__new__(ns['GCodeMove']);g.absolute_coord=g.allow_absolute_extrude=True;g.base_position=[0.,0.,0.,0.];g.last_position=b.get_position();g.homing_position=[0.,0.,0.,0.];g.axis_map={'X':0,'Y':1,'Z':2,'E':3};g.speed=25.;g.speed_factor=1./60.;g.extrude_factor=1.;g.saved_states={};g.move_with_transform=b.move
 moves=[];states=[]
 for i,command in enumerate(r['commands']):
  getattr(g,'cmd_'+command['command'])(Command(command['params']))
  if capture:states.append([list(g.last_position),tool.get_position()])
  if i%25==24:moves.extend(tool.queue.flush())
 moves.extend(tool.queue.flush())
 return dict(states=states,moves=[list(m.end_pos)+[m.move_d,m.start_v,m.cruise_v,m.end_v,m.accel_t,m.cruise_t,m.decel_t] for m in moves])
results=[run(c,True) for c in r['configs']];times=[]
for i in range(16):
 start=time.perf_counter();run(r['configs'][1]);times.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(results=results,times=times[5:],python=sys.version.split()[0])))
`;
const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',source,fileURLToPath(new URL('../../',import.meta.url))],{input:JSON.stringify({params,matrix,commands,configs}),encoding:'utf8',maxBuffer:32*1024**2}));
function run(config:typeof configs[number],capture=false){const port=new BedMeshMovePort({mesh:new BedMesh(params,matrix),fade:new BedMeshFade(config),physicalPosition:[0,0,0,0],limits:motionLimits(300,3000),validate:()=>{}}),g=new GCodeMove(port),states:number[][][]=[],moves:number[][]=[];const flush=()=>{for(const m of port.flush()){const p=m.profile!;moves.push([...m.endPos,m.distance,p.startV,p.cruiseV,p.endV,p.accelT,p.cruiseT,p.decelT]);}};for(let i=0;i<commands.length;i++){const c=commands[i];g.execute(c.command,c.params);if(capture)states.push([g.state.position,[...port.plannedPosition]]);if(i%25===24)flush();}flush();return {states,moves};}
let maxCoordinateError=0,maxVelocityError=0,maxTimeError=0,segments=0;
for(let c=0;c<configs.length;c++){const actual=run(configs[c],true),expected=ref.results[c];assert.equal(actual.moves.length,expected.moves.length);assert.equal(actual.states.length,expected.states.length);segments+=actual.moves.length;actual.states.forEach((s,i)=>s.forEach((p,j)=>p.forEach((v,k)=>{const error=Math.abs(v-expected.states[i][j][k]);maxCoordinateError=Math.max(maxCoordinateError,error);assert.ok(error<=1e-12+Math.abs(v)*1e-12);})));actual.moves.forEach((m,i)=>m.forEach((v,j)=>{const error=Math.abs(v-expected.moves[i][j]);if(j<=4)maxCoordinateError=Math.max(maxCoordinateError,error);else if(j<8)maxVelocityError=Math.max(maxVelocityError,error);else maxTimeError=Math.max(maxTimeError,error);assert.ok(error<=(j>=8?1e-12:1e-9)+Math.abs(v)*1e-11,`config ${c} segment ${i} field ${j}: ${v} / ${expected.moves[i][j]}`);}));}
const times:number[]=[];for(let i=0;i<16;i++){const start=performance.now();run(configs[1]);if(i>=5)times.push(performance.now()-start);}const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};console.log(JSON.stringify({node:process.version,python:ref.python,configs:configs.length,commandsPerConfig:commands.length,segments,maxCoordinateError,maxVelocityError,maxTimeError,nodeTime:stats(times),pythonTime:stats(ref.times),scope:'Actual AST-extracted GCodeMove -> BedMesh.move -> MoveSplitter/ZMesh -> Move/LookAheadQueue. Same forced full flush every 25 commands, no automatic lazy flush or safety validation. Includes mesh/adapter construction and profile capture. No MCU/hardware acceptance.'},null,2));
