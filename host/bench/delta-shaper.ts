import {inputShaper} from '../src/motion/shaper.ts';
import type {ShaperName} from '../src/motion/shaper.ts';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:25,queueStepTag:5,directionTag:6};
const fixtures=Array.from({length:6},(_,kind)=>{
 const initialClock=kind===5?2**32:0,mode=kind%3,towerX=80*Math.cos(mode*2*Math.PI/3),towerY=80*Math.sin(mode*2*Math.PI/3),armLength=200+kind;const name=(['zv','mzv','zvd','ei','2hump_ei','3hump_ei'] as ShaperName[])[kind];let time=initialClock/1e6+1,x=0,y=0,z=0;
 const rows:number[]=[];
 for(let i=0;i<1000;i++){const xr=i%4<2?1:-1,yr=i%8<4?.5:-.5;rows.push(time,.0001,.0008,.0001,x,y,z,xr,yr,.25,0,10,100000);x+=xr*.009;y+=yr*.009;z+=.25*.009;time=((time+.0001)+.0008)+.0001;}
 rows.push(time,0,.1,0,x,y,z,0,0,0,0,0,0);return {initialClock,mode,towerX,towerY,armLength,name,rows,end:time+.05};
});
const root=fileURLToPath(new URL('../../',import.meta.url)),dir=mkdtempSync(join(tmpdir(),'anyraid-delta-shaper-'));
const python=String.raw`
import cffi,json,sys,time
sys.path.insert(0,sys.argv[3]);from extras import shaper_defs
ffi=cffi.FFI();ffi.cdef('''
struct list_node {struct list_node *next,*prev;};struct list_head {struct list_node root;};
struct queue_message {int len;uint8_t msg[64];union {struct {uint64_t min_clock,req_clock;};struct {double sent_time,receive_time;};};uint64_t notify_id;struct list_node node;};
struct pull_history_steps {uint64_t first_clock,last_clock;int64_t start_position;int step_count,interval,add;};
struct trapq;struct stepper_kinematics;
struct trapq *trapq_alloc(void);void trapq_free(struct trapq *);void trapq_check_sentinels(struct trapq *);
void trapq_append(struct trapq *,double,double,double,double,double,double,double,double,double,double,double,double,double);
struct stepper_kinematics *delta_stepper_alloc(double,double,double);
void itersolve_set_trapq(struct stepper_kinematics *,struct trapq *,double);void itersolve_set_position(struct stepper_kinematics *,double,double,double);
int itersolve_generate_steps(struct stepper_kinematics *,struct stepcompress *,double);void free(void *);
struct stepper_kinematics *input_shaper_alloc(void);int input_shaper_set_sk(struct stepper_kinematics *,struct stepper_kinematics *);
int input_shaper_set_shaper_params(struct stepper_kinematics *,char,int,double *,double *);
struct stepcompress;
struct stepcompress *stepcompress_alloc(struct list_head *);void stepcompress_free(struct stepcompress *);
void stepcompress_fill(struct stepcompress *,uint32_t,uint32_t,int32_t,int32_t);
void stepcompress_set_time(struct stepcompress *,double,double);int stepcompress_reset(struct stepcompress *,uint64_t);
int stepcompress_append(struct stepcompress *,int,double,double);int stepcompress_flush(struct stepcompress *,uint64_t);
int stepcompress_extract_old(struct stepcompress *,struct pull_history_steps *,int,uint64_t,uint64_t);
int64_t stepcompress_find_past_position(struct stepcompress *,uint64_t);void message_queue_free(struct list_head *);
''');lib=ffi.dlopen(sys.argv[1]);fixtures=json.load(open(sys.argv[2]));MAX=2**64-1
for f in fixtures:f['rows']=[f['rows'][i:i+13] for i in range(0,len(f['rows']),13)]
def run(f,capture=True):
 queue=ffi.new('struct list_head *');root=ffi.addressof(queue,'root');root.next=root.prev=root
 sc=lib.stepcompress_alloc(queue);q=lib.trapq_alloc();sk=lib.delta_stepper_alloc(f['armLength']**2,f['towerX'],f['towerY']);lib.itersolve_set_position(sk,0,0,0)
 base=sk;sk=lib.input_shaper_alloc();assert lib.input_shaper_set_sk(sk,base)==0
 for axis,freq in [(b'x',40),(b'y',55),(b'z',45)]:
  a,t=shaper_defs.init_shaper(f['name'],freq,.1);assert lib.input_shaper_set_shaper_params(sk,axis,len(a),ffi.new('double[]',a),ffi.new('double[]',t))==0
 try:
  lib.stepcompress_fill(sc,3,25,5,6);lib.stepcompress_set_time(sc,0,1e6);assert lib.stepcompress_reset(sc,f['initialClock'])==0
  for row in f['rows']:lib.trapq_append(q,*row)
  lib.itersolve_set_trapq(sk,q,.001);lib.trapq_check_sentinels(q)
  assert lib.itersolve_generate_steps(sk,sc,f['end'])==0
  assert lib.stepcompress_flush(sc,MAX)==0
  messages=[];node=root.next
  while node!=root:
   qm=ffi.cast('struct queue_message *',ffi.cast('char *',node)-ffi.offsetof('struct queue_message','node'))
   messages.append([bytes(ffi.buffer(qm.msg,qm.len)).hex(),str(qm.min_clock),str(qm.req_clock)]);node=node.next
  history=ffi.new('struct pull_history_steps[]',len(f['rows'])*30+1);n=lib.stepcompress_extract_old(sc,history,len(f['rows'])*30+1,0,MAX)
  assert n<len(f['rows'])*30+1
  rows=[[str(getattr(history[i],k)) for k in ['first_clock','last_clock','start_position','step_count','interval','add']] for i in range(n)]
  return {'messages':messages,'history':[value for row in rows for value in row],'position':str(lib.stepcompress_find_past_position(sc,MAX))}
 finally:lib.free(sk);lib.free(base);lib.trapq_free(q);lib.stepcompress_free(sc);lib.message_queue_free(queue)
results=[run(f) for f in fixtures]
for _ in range(3):run(fixtures[0])
times=[]
for _ in range(11):
 t=time.perf_counter();run(fixtures[0]);times.append((time.perf_counter()-t)*1000)
print(json.dumps({'results':results,'times':sorted(times)}))
`;
try{
 const lib=join(dir,'stepcompress.so'),input=join(dir,'fixtures.json');writeFileSync(input,JSON.stringify(fixtures));
 const cc=spawnSync(process.env.CC??'cc',['-O2','-shared','-fPIC',...['stepcompress.c','msgblock.c','pyhelper.c','itersolve.c','kin_delta.c','kin_shaper.c','trapq.c'].map(p=>join(root,'klippy/chelper',p)),'-lm','-o',lib],{encoding:'utf8',timeout:30000});assert.equal(cc.status,0,cc.stderr);
 const p=spawnSync(process.env.PYTHON??'python3',['-c',python,lib,input,join(root,'klippy')],{encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024});assert.equal(p.status,0,p.stderr||String(p.error));const oracle=JSON.parse(p.stdout);
 const arrays=fixtures.map(f=>new Float64Array(f.rows));
 const run=(i:number)=>{using q=new TrapQueue();q.appendRaw(arrays[i]);using c=q.createStepper({...settings,initialClock:BigInt(fixtures[i].initialClock)},{kind:'delta',armLength:fixtures[i].armLength,towerX:fixtures[i].towerX,towerY:fixtures[i].towerY},.001);c.configureShapers({x:inputShaper(fixtures[i].name,40,.1),y:inputShaper(fixtures[i].name,55,.1),z:inputShaper(fixtures[i].name,45,.1)});c.generate(fixtures[i].end);const r=c.flush();return {messages:r.messages.map(m=>[m.data.toString('hex'),String(m.minClock),String(m.reqClock)]),history:[...r.history].map(String),position:String(r.position)};};
 fixtures.forEach((_,i)=>{const result=run(i);assert.equal(result.history.length,oracle.results[i].history.length,`Fixture ${i} history length`);assert.deepEqual(result,oracle.results[i]);});
 for(let i=0;i<3;i++)run(0);const times=[];for(let i=0;i<11;i++){const t=performance.now();run(0);times.push(performance.now()-t);}times.sort((a,b)=>a-b);
 console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,fixtures:fixtures.length,packetAndHistoryExact:true,moves:1000,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10],speedup:oracle.times[5]/times[5]},null,2));
}finally{rmSync(dir,{recursive:true,force:true});}
