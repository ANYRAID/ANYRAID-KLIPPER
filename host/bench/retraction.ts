import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {GCodeMove} from '../src/gcode/move.ts';
import {FirmwareRetraction} from '../src/gcode/retraction.ts';
const count=2000,warmup=3,samples=11;
const python=String.raw`
import ast,sys,json,time,logging,runpy
text=open(sys.argv[1]).read();node=next(n for n in ast.parse(text).body if isinstance(n,ast.ClassDef) and n.name=='GCodeMove')
exec(ast.get_source_segment(text,node),globals());Retraction=runpy.run_path(sys.argv[2])['FirmwareRetraction']
class Command:
 error=ValueError
 def __init__(self,p):self.p=p
 def get_command_parameters(self):return self.p
 def get(self,k,default=None):return self.p.get(k,default)
 def get_float(self,k,default=None,above=None,minval=None):
  v=self.p.get(k,default)
  if v is None:return None
  v=float(v)
  if above is not None and v<=above or minval is not None and v<minval:raise ValueError(k)
  return v
 def get_int(self,k,default=0):return int(self.p.get(k,default))
def run(capture=False):
 g=GCodeMove.__new__(GCodeMove);g.absolute_coord=g.allow_absolute_extrude=True
 g.base_position=[0.,0.,0.,0.];g.last_position=[0.,0.,0.,0.];g.homing_position=[0.,0.,0.,0.]
 g.axis_map={'X':0,'Y':1,'Z':2,'E':3};g.speed=25.;g.speed_factor=1./60.;g.extrude_factor=1.;g.saved_states={}
 moves=[];g.move_with_transform=lambda p,speed:moves.append([list(p),speed])
 class Dispatch:
  def run_script_from_command(self,script):
   for line in script.splitlines():
    tokens=line.split();p={}
    for t in tokens[1:]:
     if '=' in t:k,v=t.split('=',1)
     else:k,v=t[0],t[1:]
     p[k]=v
    getattr(g,'cmd_'+tokens[0])(Command(p))
 r=Retraction.__new__(Retraction);r.gcode=Dispatch();r.retract_length=.1;r.retract_speed=20.019;r.unretract_extra_length=.01;r.unretract_speed=10.;r.unretract_length=.11;r.is_retracted=False
 states=[]
 for i in range(2000):
  g.cmd_M220(Command({'S':50+i%100}));g.cmd_M221(Command({'S':80+i%40}))
  r.cmd_SET_RETRACTION(Command({'RETRACT_LENGTH':.1+i%7*.000005,'RETRACT_SPEED':20.019+i%3*.0001}))
  r.cmd_G10(None);r.cmd_G10(None);r.cmd_G11(None);r.cmd_G11(None)
  if capture:states.append([g.absolute_coord,g.allow_absolute_extrude,list(g.base_position),list(g.last_position),g.speed,g.speed_factor,g.extrude_factor,r.is_retracted])
 return {'states':states,'moves':moves}
result=run(True)
for _ in range(3):run()
times=[]
for _ in range(11):
 start=time.perf_counter();run();times.append((time.perf_counter()-start)*1000)
print(json.dumps({'result':result,'times':sorted(times)}))
`;
const p=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/extras/gcode_move.py',import.meta.url)),fileURLToPath(new URL('../../klippy/extras/firmware_retraction.py',import.meta.url))],{encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024});if(p.status!==0)throw Error(p.stderr||String(p.error));const oracle=JSON.parse(p.stdout);
function run(capture=false){
 const moves:[number[],number][]=[],states:unknown[]=[],g=new GCodeMove({position:()=>[0,0,0,0],move:(p,s)=>{moves.push([[...p],s]);}}),r=new FirmwareRetraction({retract_length:.1,retract_speed:20.019,unretract_extra_length:.01,unretract_speed:10});
 for(let i=0;i<count;i++){
  g.execute('M220',{S:50+i%100});g.execute('M221',{S:80+i%40});r.configure({RETRACT_LENGTH:.1+i%7*.000005,RETRACT_SPEED:20.019+i%3*.0001});r.move(g,true);r.move(g,true);r.move(g,false);r.move(g,false);
  if(capture){const s=g.state;states.push([s.absoluteCoordinates,s.absoluteExtrude,s.base,s.position,s.speed,s.speedFactor,s.extrudeFactor,r.retracted]);}
 }return {states,moves};
}
assert.deepEqual(run(true),oracle.result);
for(let i=0;i<warmup;i++)run();const times:number[]=[];for(let i=0;i<samples;i++){const start=performance.now();run();times.push(performance.now()-start);}times.sort((a,b)=>a-b);
assert(times[5]<=oracle.times[5]*1.25+2,'Median regression');assert(times[10]<=oracle.times[10]*1.5+2,'p95 regression');
console.log(JSON.stringify({node:process.version,count,warmup,samples,statesExact:true,movesCompared:oracle.result.moves.length,nodeMedianMs:times[5],pythonMedianMs:oracle.times[5],nodeP95Ms:times[10],pythonP95Ms:oracle.times[10]},null,2));
// Feed both command implementations through the same production planner/native
// solver: this isolates command-port parity, not independent solver correctness.
const {idleMotionFixture}=await import('../test/helpers/idle-motion.ts');
const {Move,LookAheadQueue,motionLimits}=await import('../src/motion/lookahead.ts');
async function native(moves:readonly [number[],number][],filtered:boolean){
 const f=idleMotionFixture(filtered),q=new LookAheadQueue(),limits=motionLimits(100,1000);let position=[50,0,0,2];
 try{for(const [p,s] of moves){const end=[p[0]+50,p[1],p[2],p[3]+2];q.add(new Move(limits,position,end,s));position=end;}f.source.startAt(1);await f.source.drain(q.flush(),new AbortController().signal);assert.equal(f.stops,0);return {ticks:f.ticks,positions:f.positions};}finally{f.close();}
}
let steps=0;const actual=run(true).moves;
for(const filtered of [false,true]){const a=await native(actual,filtered),b=await native(oracle.result.moves,filtered);assert.deepEqual(a,b);steps+=a.ticks.e.length+a.ticks.x.length;}
console.log(JSON.stringify({nativeStepsCompared:steps,nativePositionsAndClocksExact:true,filters:'off and MZV/pressure advance'}));
