import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {StepCompressor} from '../src/motion/step-compressor.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:25,queueStepTag:5,directionTag:6};
const fixtures=[0,1,2,3].map(kind=>{
 const initialClock=kind===2?2**32-1000:kind===3?2**40:0;let time=initialClock/1e6+.001;
 const rows=[];for(let i=0;i<(kind===0?20000:2000);i++){time+=(kind===1?.0001:.0008)+i%71*.000001;rows.push(Math.floor(i/(kind===1?1:500))%2,time,0);}
 return {initialClock,rows};
});
const root=fileURLToPath(new URL('../../',import.meta.url)),dir=mkdtempSync(join(tmpdir(),'anyraid-calibrated-compression-'));
const python=String.raw`
import cffi,json,sys,time
ffi=cffi.FFI();ffi.cdef('''
struct list_node {struct list_node *next,*prev;};struct list_head {struct list_node root;};
struct queue_message {int len;uint8_t msg[64];union {struct {uint64_t min_clock,req_clock;};struct {double sent_time,receive_time;};};uint64_t notify_id;struct list_node node;};
struct pull_history_steps {uint64_t first_clock,last_clock;int64_t start_position;int step_count,interval,add;};
struct stepcompress;
struct stepcompress *stepcompress_alloc(struct list_head *);void stepcompress_free(struct stepcompress *);
void stepcompress_fill(struct stepcompress *,uint32_t,uint32_t,int32_t,int32_t);
void stepcompress_set_time(struct stepcompress *,double,double);int stepcompress_reset(struct stepcompress *,uint64_t);
int stepcompress_append(struct stepcompress *,int,double,double);int stepcompress_flush(struct stepcompress *,uint64_t);
void stepcompress_history_expire(struct stepcompress *,uint64_t);
int stepcompress_extract_old(struct stepcompress *,struct pull_history_steps *,int,uint64_t,uint64_t);
int64_t stepcompress_find_past_position(struct stepcompress *,uint64_t);void message_queue_free(struct list_head *);
''');lib=ffi.dlopen(sys.argv[1]);fixtures=json.load(open(sys.argv[2]));MAX=2**64-1
for f in fixtures:f['rows']=[f['rows'][i:i+3] for i in range(0,len(f['rows']),3)]
def run(f,capture=True):
 queue=ffi.new('struct list_head *');root=ffi.addressof(queue,'root');root.next=root.prev=root
 sc=lib.stepcompress_alloc(queue)
 try:
  lib.stepcompress_fill(sc,3,25,5,6);lib.stepcompress_set_time(sc,0,1e6);assert lib.stepcompress_reset(sc,f['initialClock'])==0
  results=[];clock_offset=0.;freq=1e6
  def capture():
   messages=[];node=root.next
   while node!=root:
    qm=ffi.cast('struct queue_message *',ffi.cast('char *',node)-ffi.offsetof('struct queue_message','node'))
    messages.append([bytes(ffi.buffer(qm.msg,qm.len)).hex(),str(qm.min_clock),str(qm.req_clock)]);node=node.next
   history=ffi.new('struct pull_history_steps[]',len(f['rows'])+1);n=lib.stepcompress_extract_old(sc,history,len(f['rows'])+1,0,MAX)
   assert n<len(f['rows'])+1
   rows=[[str(getattr(history[i],k)) for k in ['first_clock','last_clock','start_position','step_count','interval','add']] for i in range(n)]
   result={'messages':messages,'history':[value for row in rows for value in row],'position':str(lib.stepcompress_find_past_position(sc,MAX))}
   lib.message_queue_free(queue);lib.stepcompress_history_expire(sc,MAX);return result
  for i in range(0,len(f['rows']),200):
   chunk=f['rows'][i:i+200]
   for row in chunk:assert lib.stepcompress_append(sc,int(row[0]),row[1],row[2])==0
   anchor=chunk[-1][1];target=(anchor-clock_offset)*freq+2
   freq=1e6+(100 if (i//200)%2 else -100);clock_offset=anchor-target/freq
   lib.stepcompress_set_time(sc,clock_offset,freq)
   until=max(f['initialClock']/1e6,chunk[-1][1]-.002)
   assert lib.stepcompress_flush(sc,int((until-clock_offset)*freq+.5))==0
   results.append(capture())
  assert lib.stepcompress_flush(sc,MAX)==0
  results.append(capture());return results
 finally:lib.stepcompress_free(sc);lib.message_queue_free(queue)
results=[run(f) for f in fixtures]
for _ in range(3):run(fixtures[0])
times=[]
for _ in range(11):
 t=time.perf_counter();run(fixtures[0]);times.append((time.perf_counter()-t)*1000)
print(json.dumps({'results':results,'times':sorted(times)}))
`;
try{
 const lib=join(dir,'stepcompress.so'),input=join(dir,'fixtures.json');writeFileSync(input,JSON.stringify(fixtures));
 const baseline=spawnSync('git',['show','20a22102:klippy/chelper/stepcompress.c'],{cwd:root,encoding:'utf8'});assert.equal(baseline.status,0,baseline.stderr);writeFileSync(join(dir,'original-stepcompress.c'),baseline.stdout);
 const cc=spawnSync(process.env.CC??'cc',['-O2','-shared','-fPIC','-I'+join(root,'klippy/chelper'),...['stepcompress.c','msgblock.c','pyhelper.c'].map(p=>p==='stepcompress.c'?join(dir,'original-stepcompress.c'):join(root,'klippy/chelper',p)),'-lm','-o',lib],{encoding:'utf8',timeout:30000});assert.equal(cc.status,0,cc.stderr);
 const p=spawnSync(process.env.PYTHON??'python3',['-c',python,lib,input],{encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024});assert.equal(p.status,0,p.stderr||String(p.error));const oracle=JSON.parse(p.stdout);
 const arrays=fixtures.map(f=>new Float64Array(f.rows));
 const run=(i:number)=>{using c=new StepCompressor({...settings,initialClock:BigInt(fixtures[i].initialClock)});const results=[];let clockOffset=0,frequency=1e6;
 const capture=(r:ReturnType<StepCompressor['flush']>)=>({messages:r.messages.map(m=>[m.data.toString('hex'),String(m.minClock),String(m.reqClock)]),history:[...r.history].map(String),position:String(r.position)});
 for(let offset=0;offset<arrays[i].length;offset+=600){const rows=arrays[i].subarray(offset,offset+600);c.append(rows);const anchor=rows[rows.length-2],target=(anchor-clockOffset)*frequency+2;frequency=1e6+((offset/600)%2?100:-100);clockOffset=anchor-target/frequency;c.calibrateClock(clockOffset,frequency);results.push(capture(c.flushThrough(Math.max(fixtures[i].initialClock/1e6,rows[rows.length-2]-.002))));}
 results.push(capture(c.flush()));return results;};
 fixtures.forEach((_,i)=>assert.deepEqual(run(i),oracle.results[i]));
 for(let i=0;i<3;i++)run(0);const times=[];for(let i=0;i<11;i++){const t=performance.now();run(0);times.push(performance.now()-t);}times.sort((a,b)=>a-b);
 console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,fixtures:fixtures.length,packetAndHistoryExact:true,steps:20000,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10],speedup:oracle.times[5]/times[5]},null,2));
}finally{rmSync(dir,{recursive:true,force:true});}
