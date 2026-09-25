import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {VelocityLimits} from '../src/motion/velocity-limits.ts';
import {velocityUpdate} from '../src/gcode/velocity-limits.ts';
import {BedMeshMovePort} from '../src/motion/bed-mesh-port.ts';
import {motionLimits,type Move} from '../src/motion/lookahead.ts';
import {idleMotionFixture} from '../test/helpers/idle-motion.ts';
const commands:{name:string;params:Record<string,string>}[]=[
 {name:'M204',params:{S:'1200'}},{name:'SET_VELOCITY_LIMIT',params:{VELOCITY:'70',ACCEL:'800',SQUARE_CORNER_VELOCITY:'3',MINIMUM_CRUISE_RATIO:'.2'}},
 {name:'M204',params:{P:'250',T:'150'}},{name:'SET_VELOCITY_LIMIT',params:{MINIMUM_CRUISE_RATIO:'0'}},{name:'SET_VELOCITY_LIMIT',params:{SQUARE_CORNER_VELOCITY:'0'}},
 {name:'M204',params:{S:'1_000',P:'invalid'}},{name:'SET_VELOCITY_LIMIT',params:{VELOCITY:'100',SQUARE_CORNER_VELOCITY:'5',MINIMUM_CRUISE_RATIO:'.5'}},
 {name:'M204',params:{P:'100'}},{name:'SET_VELOCITY_LIMIT',params:{}},
];
const count=2000,initial=motionLimits(100,1000),nodePulses:{ticks:Record<string,[bigint,bigint][]>;positions:Record<string,bigint>}[]=[];for(const filtered of [false,true])nodePulses.push(await native(filtered));
const python=String.raw`
import ast,json,sys,math,time,types,logging
text=open(sys.argv[1]).read();tree=ast.parse(text)
for name in ['Move','LookAheadQueue','ToolHead','ToolHeadCommandHelper']:
 node=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name==name);exec(ast.get_source_segment(text,node),globals())
LOOKAHEAD_FLUSH_TIME=.150
commands=json.loads(sys.argv[2]);count=int(sys.argv[3])
class Command:
 def __init__(self,params):self.params=params
 def get_float(self,key,default=None,above=None,minval=None,below=None):
  value=float(self.params[key]) if key in self.params else default
  if value is not None and (above is not None and value<=above or minval is not None and value<minval or below is not None and value>=below):raise ValueError(key)
  return value
 def respond_info(self,*a,**k):pass
 def get_commandline(self):return 'M204'
def setup():
 head=ToolHead.__new__(ToolHead);head.max_velocity=100.;head.max_accel=1000.;head.square_corner_velocity=5.;head.min_cruise_ratio=.5;head.extra_axes=[];head._calc_junction_deviation()
 helper=ToolHeadCommandHelper.__new__(ToolHeadCommandHelper);helper.toolhead=head;helper.printer=types.SimpleNamespace(set_rollover_info=lambda *a:None);return head,helper
def update(helper,command):getattr(helper,'cmd_'+command['name'])(Command(command['params']))
head,helper=setup();states=[]
for c in commands:
 update(helper,c);states.append([head.max_velocity,head.max_accel,head.square_corner_velocity,head.min_cruise_ratio,head.junction_deviation,head.mcr_pseudo_accel])
def run():
 head,helper=setup();queue=LookAheadQueue();position=[50.,0.,0.,2.];out=[]
 for i in range(count):
  update(helper,commands[i%7]);target=[50+(i%2)*.2,(i%4)*.1,0.,2+i*.0001];move=Move(head,position,target,100.);position=target
  if not move.move_d:continue
  if queue.add_move(move):out.extend(queue.flush(lazy=True))
 out.extend(queue.flush());return out
out=run();profiles=[[m.accel,m.junction_deviation,m.max_cruise_v2,m.start_v,m.cruise_v,m.end_v,m.accel_t,m.cruise_t,m.decel_t] for m in out];times=[]
for sample in range(14):
 start=time.perf_counter();run()
 if sample>=3:times.append((time.perf_counter()-start)*1000)
import cffi
sys.path.insert(0,sys.argv[5]);from extras import shaper_defs
ffi=cffi.FFI();ffi.cdef('''
struct list_node {struct list_node *next,*prev;};struct list_head {struct list_node root;};
struct pull_history_steps {uint64_t first_clock,last_clock;int64_t start_position;int step_count,interval,add;};
struct trapq;struct stepper_kinematics;struct stepcompress;
struct trapq *trapq_alloc(void);void trapq_free(struct trapq *);void trapq_check_sentinels(struct trapq *);
void trapq_append(struct trapq *,double,double,double,double,double,double,double,double,double,double,double,double,double);
struct stepper_kinematics *cartesian_stepper_alloc(char);struct stepper_kinematics *extruder_stepper_alloc(void);
void extruder_stepper_free(struct stepper_kinematics *);void extruder_set_pressure_advance(struct stepper_kinematics *,double,double,double);
void itersolve_set_trapq(struct stepper_kinematics *,struct trapq *,double);void itersolve_set_position(struct stepper_kinematics *,double,double,double);
int itersolve_generate_steps(struct stepper_kinematics *,struct stepcompress *,double);void free(void *);
struct stepper_kinematics *input_shaper_alloc(void);int input_shaper_set_sk(struct stepper_kinematics *,struct stepper_kinematics *);
int input_shaper_set_shaper_params(struct stepper_kinematics *,char,int,double *,double *);
struct stepcompress *stepcompress_alloc(struct list_head *);void stepcompress_free(struct stepcompress *);
void stepcompress_fill(struct stepcompress *,uint32_t,uint32_t,int32_t,int32_t);void stepcompress_set_time(struct stepcompress *,double,double);
int stepcompress_reset(struct stepcompress *,uint64_t);int stepcompress_set_last_position(struct stepcompress *,uint64_t,int64_t);
int stepcompress_flush(struct stepcompress *,uint64_t);int stepcompress_extract_old(struct stepcompress *,struct pull_history_steps *,int,uint64_t,uint64_t);
int64_t stepcompress_find_past_position(struct stepcompress *,uint64_t);void message_queue_free(struct list_head *);
double oracle_position(struct stepper_kinematics *,struct trapq *,double);
''');lib=ffi.dlopen(sys.argv[4]);MAX=2**64-1;node_pulses=json.load(open(sys.argv[6]))
def native(axis,filtered):
 messages=ffi.new('struct list_head *');root=ffi.addressof(messages,'root');root.next=root.prev=root
 sc=lib.stepcompress_alloc(messages);q=lib.trapq_alloc();base=lib.extruder_stepper_alloc() if axis=='e' else lib.cartesian_stepper_alloc(b'x');sk=base;origin=2. if axis=='e' else 50.
 if filtered and axis=='x':
  sk=lib.input_shaper_alloc();assert lib.input_shaper_set_sk(sk,base)==0
  a,t=shaper_defs.init_shaper('mzv',40,.1);assert lib.input_shaper_set_shaper_params(sk,b'x',len(a),ffi.new('double[]',a),ffi.new('double[]',t))==0
 if filtered and axis=='e':lib.extruder_set_pressure_advance(sk,0,.05,.04)
 try:
  lib.stepcompress_fill(sc,4 if axis=='e' else 3,0,5,6);lib.stepcompress_set_time(sc,0,1e6);assert lib.stepcompress_reset(sc,0)==0;assert lib.stepcompress_set_last_position(sc,0,20 if axis=='e' else 100)==0
  lib.itersolve_set_position(sk,origin,0,0);lib.trapq_append(q,0,0,1,0,origin,0,0,0,0,0,0,0,0);time_at=1.
  for m in out:
   ratio=m.axes_r[3] if axis=='e' else 1.;pos=[m.start_pos[3],0.,0.] if axis=='e' else m.start_pos[:3];axes=[1.,1. if ratio>0 and (m.axes_d[0] or m.axes_d[1]) else 0.,0.] if axis=='e' else m.axes_r[:3]
   lib.trapq_append(q,time_at,m.accel_t,m.cruise_t,m.decel_t,*pos,*axes,m.start_v*ratio,m.cruise_v*ratio,m.accel*ratio);time_at=((time_at+m.accel_t)+m.cruise_t)+m.decel_t
  end=out[-1].end_pos;pos=[end[3],0.,0.] if axis=='e' else end[:3];lib.trapq_append(q,time_at,0,1,0,*pos,0,0,0,0,0,0)
  lib.itersolve_set_trapq(sk,q,.01);lib.trapq_check_sentinels(q);assert lib.itersolve_generate_steps(sk,sc,time_at+.1)==0;assert lib.stepcompress_flush(sc,MAX)==0
  rows=ffi.new('struct pull_history_steps[]',count*40);n=lib.stepcompress_extract_old(sc,rows,count*40,0,MAX);assert n<count*40;ticks=[]
  for i in range(n):
   row=rows[i]
   for j in range(abs(row.step_count)):ticks.append([str(row.first_clock+j*row.interval+row.add*j*(j+1)//2),str(row.start_position+(-1 if row.step_count<0 else 1)*(j+1))])
  expected=sorted(ticks,key=lambda row:int(row[0]));actual=sorted(node_pulses[int(filtered)]['ticks'][axis],key=lambda row:int(row[0]));assert len(expected)==len(actual);conditioned=[];previous=20 if axis=='e' else 100
  for index,(a,b) in enumerate(zip(expected,actual)):
   assert a[1]==b[1];position=int(a[1]);direction=position-previous;assert abs(direction)==1;previous=position
   if abs(int(a[0])-int(b[0]))<=1:continue
   # Near a stationary step threshold the root time is ill-conditioned. Keep
   # a 100us ceiling (itersolve SEEK_TIME_RESET), plus its unchanged 1e-9mm
   # position stopping criterion evaluated by the original C callback.
   assert abs(int(a[0])-int(b[0]))<=100
   pa=lib.oracle_position(sk,q,int(a[0])/1e6);pb=lib.oracle_position(sk,q,int(b[0])/1e6);threshold=origin+(position-(20 if axis=='e' else 100)-.5*direction)*.01;error=max(abs(pa-threshold),abs(pb-threshold))
   assert math.isfinite(error) and error<=1e-9,(axis,filtered,index,a,b,pa,pb,threshold,error)
   conditioned.append(dict(index=index,error=error))
  return dict(ticks=ticks,position=str(lib.stepcompress_find_past_position(sc,MAX)),conditioned=conditioned)
 finally:
  if axis=='e':lib.extruder_stepper_free(sk)
  else:
   lib.free(sk)
   if sk!=base:lib.free(base)
  lib.trapq_free(q);lib.stepcompress_free(sc);lib.message_queue_free(messages)
pulses=[{axis:native(axis,filtered) for axis in ['x','e']} for filtered in [False,True]]
print(json.dumps(dict(states=states,profiles=profiles,times=sorted(times),pulses=pulses)))
`;
const root=fileURLToPath(new URL('../../',import.meta.url)),dir=mkdtempSync(join(tmpdir(),'velocity-oracle-'));
let reference:{states:number[][];profiles:number[][];times:number[];pulses:Record<string,{ticks:[string,string][];position:string;conditioned:{index:number;error:number}[]}>[]};
try{const library=join(dir,'motion.so'),probe=join(dir,'probe.c'),input=join(dir,'node.json');writeFileSync(input,JSON.stringify(nodePulses,(_key,value)=>typeof value==='bigint'?String(value):value));writeFileSync(probe,'#include <stddef.h>\n#include <stdint.h>\n#include <math.h>\n#include "itersolve.h"\n#include "trapq.h"\ndouble oracle_position(struct stepper_kinematics *sk,struct trapq *q,double t){struct move *m;list_for_each_entry(m,&q->moves,node){if(m->move_t>0 && t>=m->print_time && t<=m->print_time+m->move_t)return sk->calc_position_cb(sk,m,t-m->print_time);}return NAN;}\n');const cc=spawnSync(process.env.CC??'cc',['-O2','-shared','-fPIC','-I',join(root,'klippy/chelper'),probe,...['stepcompress.c','msgblock.c','pyhelper.c','itersolve.c','kin_cartesian.c','kin_extruder.c','kin_shaper.c','trapq.c'].map(p=>join(root,'klippy/chelper',p)),'-lm','-o',library],{encoding:'utf8',timeout:30000});assert.equal(cc.status,0,cc.stderr);const result=spawnSync(process.env.PYTHON??'python3',['-c',python,join(root,'klippy/toolhead.py'),JSON.stringify(commands),String(count),library,join(root,'klippy') ,input],{encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024});if(result.status!==0)throw new Error(result.stderr||String(result.error));reference=JSON.parse(result.stdout);}finally{rmSync(dir,{recursive:true,force:true});}
const state=new VelocityLimits(initial);let resolved=initial;
for(let i=0;i<commands.length;i++){const c=commands[i],patch=velocityUpdate(c.name,c.params);if(patch)state.update(patch,l=>{resolved=l;});const s=state.state;assert.deepEqual([s.maxVelocity,s.maxAccel,s.squareCornerVelocity,s.minCruiseRatio,resolved.junctionDeviation,resolved.mcrPseudoAccel],reference.states[i]);}
function run(){const limits=new VelocityLimits(initial),port=new BedMeshMovePort({mesh:null,physicalPosition:[50,0,0,2],limits:initial,validate:()=>{}}),out:Move[]=[];
 for(let i=0;i<count;i++){const c=commands[i%7],patch=velocityUpdate(c.name,c.params)!;limits.update(patch,l=>port.setMotionLimits(l));port.move([50+(i%2)*.2,(i%4)*.1,0,2+i*.0001],100);if(port.flushDue)for(const m of port.flush(true))out.push(m);}for(const m of port.flush())out.push(m);return out;}
const planned=run();assert.equal(planned.length,reference.profiles.length);let maxProfileError=0;for(let i=0;i<planned.length;i++){const m=planned[i],p=m.profile!,values=[m.accel,m.junctionDeviation,m.maxCruiseV2,p.startV,p.cruiseV,p.endV,p.accelT,p.cruiseT,p.decelT];for(let j=0;j<values.length;j++){const error=Math.abs(values[j]-reference.profiles[i][j]);assert(error<=1e-12*Math.max(1,Math.abs(values[j])));maxProfileError=Math.max(error,maxProfileError);}}
async function native(filtered:boolean){const f=idleMotionFixture(filtered);try{f.source.startAt(1);await f.source.drain(run(),new AbortController().signal);assert.equal(f.stops,0);return {ticks:f.ticks,positions:f.positions};}finally{f.close();}}
let stepsCompared=0,maxTickDifference=0n,conditionedClockCases=0,maxRootError=0;for(const filtered of [false,true]){const a=reference.pulses[Number(filtered)],b=nodePulses[Number(filtered)];for(const axis of ['x','e']){assert.equal(BigInt(a[axis].position),b.positions[axis]);const expected=a[axis].ticks.map(row=>row.map(BigInt) as [bigint,bigint]),actual=b.ticks[axis],sort=(a:[bigint,bigint],b:[bigint,bigint])=>a[0]<b[0]?-1:a[0]>b[0]?1:0;expected.sort(sort);actual.sort(sort);assert.equal(expected.length,actual.length);for(let i=0;i<expected.length;i++){assert.equal(expected[i][1],actual[i][1]);const delta=expected[i][0]-actual[i][0],abs=delta<0n?-delta:delta;if(abs>1n){const proof=a[axis].conditioned.find(c=>c.index===i);assert(proof&&proof.error<=1e-9);conditionedClockCases++;maxRootError=Math.max(maxRootError,proof.error);}if(abs>maxTickDifference)maxTickDifference=abs;stepsCompared++;}}}
const times:number[]=[];for(let sample=0;sample<14;sample++){const start=performance.now();run();if(sample>=3)times.push(performance.now()-start);}times.sort((a,b)=>a-b);const limits={medianRatio:1.25,p95Ratio:1.5,slackMs:2};console.log(JSON.stringify({node:process.version,commandCases:commands.length,statesExact:true,movesCompared:planned.length,maxProfileError,stepsCompared,maxTickDifference:String(maxTickDifference),conditionedClockCases,maxRootError,rootToleranceMm:1e-9,conditionedMaxClockTicks:100,count,warmup:3,samples:11,nodeMotion:{medianMs:times[5],p95Ms:times[10]},pythonMotion:{medianMs:reference.times[5],p95Ms:reference.times[10]},limits,scope:'Unmodified repository Python commands, lookahead and C/CFFI solvers versus TS admission and native solvers. X/E pulses include shaping and pressure advance. Above-one-tick differences require direct reference-C position proof at both timestamps within the original itersolve 1e-9 mm tolerance of the same step threshold. Excludes UART, physical timing and network.'}));assert(times[5]<=reference.times[5]*limits.medianRatio+limits.slackMs);assert(times[10]<=reference.times[10]*limits.p95Ratio+limits.slackMs);
