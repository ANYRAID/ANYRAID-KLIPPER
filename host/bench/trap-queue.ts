import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
const count=10000,rows=new Float64Array(count*13);let time=1;
for(let i=0;i<count;i++) {rows.set([time,.0001,.0008,.0001,i*.0009,0,0,1,0,0,0,1,10000],i*13);time=((time+.0001)+.0008)+.0001;}
const dir=mkdtempSync(join(tmpdir(),'anyraid-trapq-'));
const python=String.raw`
import cffi,array,json,time,sys
ffi=cffi.FFI();ffi.cdef('''
struct trapq;struct pull_move {double print_time,move_t,start_v,accel,start_x,start_y,start_z,x_r,y_r,z_r;};
struct trapq *trapq_alloc(void);void trapq_free(struct trapq *);
void trapq_append(struct trapq *,double,double,double,double,double,double,double,double,double,double,double,double,double);
int trapq_extract_old(struct trapq *,struct pull_move *,int,double,double);
''')
lib=ffi.dlopen(sys.argv[1]);values=array.array('d');values.frombytes(open(sys.argv[2],'rb').read());rows=[list(values[i:i+13]) for i in range(0,len(values),13)]
def run(capture=False):
 q=lib.trapq_alloc()
 try:
  for row in rows:lib.trapq_append(q,*row)
  if capture:
   output=ffi.new('struct pull_move[]',len(rows)*3);n=lib.trapq_extract_old(q,output,len(rows)*3,0,100)
   return [[getattr(output[i],key) for key in ['print_time','move_t','start_v','accel','start_x','start_y','start_z','x_r','y_r','z_r']] for i in range(n)]
 finally:lib.trapq_free(q)
result=run(True)
for _ in range(3):run()
times=[]
for _ in range(11):
 start=time.perf_counter();run();times.append((time.perf_counter()-start)*1000)
print(json.dumps({'rows':result,'times':sorted(times),'cffi':cffi.__version__}))
`;
let oracle;
try {
  const root=fileURLToPath(new URL('../../',import.meta.url)),lib=join(dir,'trapq.so'),input=join(dir,'input.bin');
  const compile=spawnSync(process.env.CC??'cc',['-O2','-shared','-fPIC',`-I${join(root,'src')}`,join(root,'klippy/chelper/trapq.c'),'-lm','-o',lib],{encoding:'utf8',timeout:60000});
  if(compile.status!==0) throw new Error(compile.stderr);
  writeFileSync(input,Buffer.from(rows.buffer));
  const result=spawnSync(process.env.PYTHON??'python3',['-c',python,lib,input],{encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});
  if(result.status!==0) throw new Error(result.stderr||String(result.error));oracle=JSON.parse(result.stdout);
} finally {rmSync(dir,{recursive:true,force:true});}
const queue=new TrapQueue();try {queue.appendRaw(rows);assert.deepEqual([...queue.extract(count*3,0,100)],oracle.rows.flat());}finally{queue.dispose();}
function run(batch:boolean):void {
  const q=new TrapQueue();try {
    if(batch)q.appendRaw(rows);else for(let i=0;i<count;i++)q.appendRaw(rows.subarray(i*13,(i+1)*13));
  } finally {q.dispose();}
}
const report:Record<string,unknown>={node:process.version,cpu:cpus()[0].model,moves:count,exactComparedSegments:oracle.rows.length,cffi:oracle.cffi,pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10]};
let batchMedian=0;
for(const batch of [false,true]) {
  for(let i=0;i<3;i++)run(batch);const times=[];
  for(let i=0;i<11;i++) {const start=performance.now();run(batch);times.push(performance.now()-start);}
  times.sort((a,b)=>a-b);report[batch?'batch':'perMove']={medianMs:times[5],p95Ms:times[10]};if(batch)batchMedian=times[5];
}
report.speedup=oracle.times[5]/batchMedian;console.log(JSON.stringify(report,null,2));
assert.ok(batchMedian<=oracle.times[5],'Native batch queue bridge regressed against Python/CFFI');
