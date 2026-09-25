import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:25,queueStepTag:5,directionTag:6};
const fixtures=Array.from({length:8},(_,kind)=>{
 const initialClock=kind===7?2**32:0,advance=[.02,0,.05,.2,.05,.02,.05,.05][kind],smooth=[.04,.04,.02,.2,0,.04,.2,.04][kind];let time=initialClock/1e6+1,x=0;
 const rows:number[]=[];
 for(let i=0;i<1000;i++){const sign=i%4<2?1:-1,eligible=kind===5?0:sign>0?1:0;rows.push(time,.0001,.0008,.0001,x,0,0,1,eligible,0,0,sign*10,sign*100000);x+=sign*.009;time=((time+.0001)+.0008)+.0001;}
 rows.push(time,0,.3,0,x,0,0,0,0,0,0,0,0);return {change:undefined as {advance:number;smooth:number}|undefined,initialClock,advance,smooth,rows,end:time+.15,prefix:initialClock/1e6+1.3,updates:advance&&smooth?[[initialClock/1e6+1.1,advance*1.25],[initialClock/1e6+1.6,advance*1.5]]:[]};
});
for(const [advance,smooth,nextAdvance,nextSmooth] of [[0,.04,.1,.04],[.05,.04,0,.04],[.05,.04,.1,.2],[.05,.2,.1,.02],[.05,.04,.1,0],[.05,0,.1,.04],[0,.04,.1,0],[.05,.04,.05,.2]]){const base=fixtures[0],x=base.rows.at(-9)!;fixtures.push({...base,advance,smooth,updates:[],prefix:2.15,end:3.15,change:{advance:nextAdvance,smooth:nextSmooth},rows:[...base.rows,2.5,.125,.25,.125,x,0,0,1,1,0,0,8,64,3,0,.3,0,x+3,0,0,0,0,0,0,0,0]});}
const root=fileURLToPath(new URL('../../',import.meta.url)),dir=mkdtempSync(join(tmpdir(),'anyraid-pressure-advance-'));
const python=String.raw`
import cffi,json,sys,time

ffi=cffi.FFI();ffi.cdef('''
struct list_node {struct list_node *next,*prev;};struct list_head {struct list_node root;};
struct queue_message {int len;uint8_t msg[64];union {struct {uint64_t min_clock,req_clock;};struct {double sent_time,receive_time;};};uint64_t notify_id;struct list_node node;};
struct pull_history_steps {uint64_t first_clock,last_clock;int64_t start_position;int step_count,interval,add;};
struct trapq;struct stepper_kinematics;
struct trapq *trapq_alloc(void);void trapq_free(struct trapq *);void trapq_check_sentinels(struct trapq *);
void trapq_append(struct trapq *,double,double,double,double,double,double,double,double,double,double,double,double,double);
struct stepper_kinematics *extruder_stepper_alloc(void);void extruder_stepper_free(struct stepper_kinematics *);void extruder_set_pressure_advance(struct stepper_kinematics *,double,double,double);
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
 sc=lib.stepcompress_alloc(queue);q=lib.trapq_alloc();sk=lib.extruder_stepper_alloc()
 lib.itersolve_set_position(sk,0,0,0);lib.extruder_set_pressure_advance(sk,0,f['advance'],f['smooth'] if f['advance'] else 0)
 for t,a in f['updates']:lib.extruder_set_pressure_advance(sk,t,a,f['smooth'])
 try:
  lib.stepcompress_fill(sc,3,25,5,6);lib.stepcompress_set_time(sc,0,1e6);assert lib.stepcompress_reset(sc,f['initialClock'])==0
  for row in f['rows']:lib.trapq_append(q,*row)
  lib.itersolve_set_trapq(sk,q,.01);lib.trapq_check_sentinels(q)
  assert lib.itersolve_generate_steps(sk,sc,f['prefix'])==0
  if f.get('change'):lib.extruder_set_pressure_advance(sk,0,f['change']['advance'],f['change']['smooth'] if f['change']['advance'] else 0)
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
 finally:lib.extruder_stepper_free(sk);lib.trapq_free(q);lib.stepcompress_free(sc);lib.message_queue_free(queue)
results=[run(f) for f in fixtures]
for _ in range(3):run(fixtures[0])
times=[]
for _ in range(11):
 t=time.perf_counter();run(fixtures[0]);times.append((time.perf_counter()-t)*1000)
for _ in range(3):run(fixtures[8])
window_times=[]
for _ in range(11):
 t=time.perf_counter();run(fixtures[8]);window_times.append((time.perf_counter()-t)*1000)
print(json.dumps({'results':results,'times':sorted(times),'windowTimes':sorted(window_times)}))
`;
try{
 const lib=join(dir,'stepcompress.so'),input=join(dir,'fixtures.json');writeFileSync(input,JSON.stringify(fixtures));
 const cc=spawnSync(process.env.CC??'cc',['-O2','-shared','-fPIC',...['stepcompress.c','msgblock.c','pyhelper.c','itersolve.c','kin_extruder.c','trapq.c'].map(p=>join(root,'klippy/chelper',p)),'-lm','-o',lib],{encoding:'utf8',timeout:30000});assert.equal(cc.status,0,cc.stderr);
 const p=spawnSync(process.env.PYTHON??'python3',['-c',python,lib,input,join(root,'klippy')],{encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024});assert.equal(p.status,0,p.stderr||String(p.error));const oracle=JSON.parse(p.stdout);
 const arrays=fixtures.map(f=>new Float64Array(f.rows));
 const run=(i:number,cancel=false,revise=false)=>{using q=new TrapQueue();q.appendRaw(arrays[i]);using c=q.createStepper({...settings,initialClock:BigInt(fixtures[i].initialClock)},'extruder',.01);c.configurePressureAdvance(fixtures[i].advance,fixtures[i].smooth);for(const [t,a] of fixtures[i].updates)c.schedulePressureAdvance(t,a);if(cancel)c.schedulePressureAdvance(fixtures[i].initialClock/1e6+1.8,fixtures[i].advance*2);c.generate(fixtures[i].prefix);if(fixtures[i].change){const change=fixtures[i].change!;c.reconfigurePressureAdvance(change.advance,change.smooth);}if(revise){const [t,a]=fixtures[i].updates.at(-1)!;c.setPressureAdvanceAtTail(t,a*2);c.setPressureAdvanceAtTail(t,a);}if(cancel)c.cancelPressureAdvanceAfter(fixtures[i].initialClock/1e6+1.7);c.generate(fixtures[i].end);const r=c.flush();return {messages:r.messages.map(m=>[m.data.toString('hex'),String(m.minClock),String(m.reqClock)]),history:[...r.history].map(String),position:String(r.position)};};
 fixtures.forEach((_,i)=>{const result=run(i);assert.equal(result.history.length,oracle.results[i].history.length,`Fixture ${i} history length`);assert.deepEqual(result,oracle.results[i]);});
 let cancellationFixtures=0;for(let i=0;i<fixtures.length;i++)if(fixtures[i].advance&&fixtures[i].smooth&&!fixtures[i].change){assert.deepEqual(run(i,true),oracle.results[i]);assert.deepEqual(run(i,false,true),oracle.results[i]);cancellationFixtures++;}
 for(let i=0;i<3;i++)run(0);const times=[];for(let i=0;i<11;i++){const t=performance.now();run(0);times.push(performance.now()-t);}times.sort((a,b)=>a-b);
 assert(times[5]<=oracle.times[5]*1.25+2);assert(times[10]<=oracle.times[10]*1.5+2);
 const cancelledTimes:number[]=[];for(let i=0;i<14;i++){const t=performance.now();run(0,true);if(i>=3)cancelledTimes.push(performance.now()-t);}cancelledTimes.sort((a,b)=>a-b);
 assert(cancelledTimes[5]<=times[5]*1.25+2);assert(cancelledTimes[10]<=times[10]*1.5+2);
 const windowTimes:number[]=[];for(let i=0;i<14;i++){const t=performance.now();run(8);if(i>=3)windowTimes.push(performance.now()-t);}windowTimes.sort((a,b)=>a-b);assert(windowTimes[5]<=oracle.windowTimes[5]*1.25+2);assert(windowTimes[10]<=oracle.windowTimes[10]*1.5+2);
 // Measure a real retained solver after prefix generation; each pair rebuilds
 // its private parameter list without discarding generated or queued steps.
 using pairQueue=new TrapQueue();pairQueue.appendRaw(arrays[0]);using pairStepper=pairQueue.createStepper(settings,'extruder',.01);
 pairStepper.configurePressureAdvance(fixtures[0].advance,fixtures[0].smooth);for(const [t,a] of fixtures[0].updates)pairStepper.schedulePressureAdvance(t,a);pairStepper.generate(fixtures[0].prefix);
 const pairTimes:number[]=[],pairs=10000;for(let sample=0;sample<14;sample++){const t=performance.now();for(let i=0;i<pairs;i++){pairStepper.schedulePressureAdvance(1.8,.2);pairStepper.cancelPressureAdvanceAfter(1.7);}if(sample>=3)pairTimes.push((performance.now()-t)*1000/pairs);}pairTimes.sort((a,b)=>a-b);
 assert(pairTimes[5]<50);assert(pairTimes[10]<100);
 const tailTimes:number[]=[];for(let sample=0;sample<14;sample++){const t=performance.now();for(let i=0;i<pairs;i++){pairStepper.setPressureAdvanceAtTail(1.7,.2);pairStepper.setPressureAdvanceAtTail(1.7,fixtures[0].advance*1.5);}if(sample>=3)tailTimes.push((performance.now()-t)*1000/pairs);}tailTimes.sort((a,b)=>a-b);assert(tailTimes[5]<50);assert(tailTimes[10]<100);
 pairStepper.generate(fixtures[0].end);const pairResult=pairStepper.flush();assert.deepEqual({messages:pairResult.messages.map(m=>[m.data.toString('hex'),String(m.minClock),String(m.reqClock)]),history:[...pairResult.history].map(String),position:String(pairResult.position)},oracle.results[0]);
 console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,fixtures:fixtures.length,packetAndHistoryExact:true,cancellationFixtures,moves:1000,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10],speedup:oracle.times[5]/times[5],cancelledPathMedianMs:cancelledTimes[5],cancelledPathP95Ms:cancelledTimes[10],scheduleCancelPairMedianUs:pairTimes[5],scheduleCancelPairP95Us:pairTimes[10],tailRevisionFixtures:cancellationFixtures,tailRevisionPairMedianUs:tailTimes[5],tailRevisionPairP95Us:tailTimes[10],windowFixtures:fixtures.filter(f=>f.change).length,windowNodeMedianMs:windowTimes[5],windowNodeP95Ms:windowTimes[10],windowPythonMedianMs:oracle.windowTimes[5],windowPythonP95Ms:oracle.windowTimes[10],pairsPerSample:pairs},null,2));
}finally{rmSync(dir,{recursive:true,force:true});}
