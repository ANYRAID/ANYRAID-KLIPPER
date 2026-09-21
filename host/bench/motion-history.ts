import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
using a=new TrapQueue();using b=new TrapQueue();const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};using x=a.createStepper(settings,'x',.01);using e=b.createStepper({...settings,frequency:2e6,timeOffset:-5,oid:4},'extruder',.01);
const c=new MotionCoordinator([{id:'x',queue:a,stepper:x},{id:'e',queue:b,stepper:e}],{async commit(){},async stop(){}}),samples=Array.from({length:5000},(_,i)=>({x:BigInt(i*250000),e:BigInt(i*450000)}));
const script=String.raw`import ast,json,sys,types
text=open(sys.argv[1]).read();tree=ast.parse(text)
expire=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='MOVE_HISTORY_EXPIRE' for t in n.targets))
cls=next(n for n in tree.body if isinstance(n,ast.ClassDef) and any(isinstance(m,ast.FunctionDef) and m.name=='stats' for m in n.body))
method=next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name=='stats')
g={'chelper':types.SimpleNamespace(get_ffi=lambda:(None,None)),'MOVE_HISTORY_EXPIRE':expire};exec(ast.get_source_segment(text,method),g)
result=[]
for value in json.load(sys.stdin):
 s=types.SimpleNamespace(last_step_gen_time=0,steppersyncs=[],mcu=types.SimpleNamespace(estimated_print_time=lambda t:value))
 g['stats'](s,0);result.append(s.clear_history_time)
print(json.dumps(result))
`;
const result=spawnSync(process.env.PYTHON??'python3',['-c',script,fileURLToPath(new URL('../../klippy/extras/motion_queuing.py',import.meta.url))],{input:JSON.stringify(samples.map(s=>Math.min(Number(s.x)/1e6,Number(s.e)/2e6-5))),encoding:'utf8',timeout:30000,maxBuffer:1024*1024});if(result.status!==0)throw new Error(result.stderr||String(result.error));const expected=JSON.parse(result.stdout) as number[];let maxExtraRetention=0;
for(let i=0;i<samples.length;i++){const cutoff=c.historyCutoff(samples[i]),extra=expected[i]-cutoff;assert.ok(extra>=0&&extra<=.001000001);maxExtraRetention=Math.max(maxExtraRetention,extra);}
const times:number[]=[];let checksum=0;for(let i=0;i<16;i++){const start=performance.now();for(const sample of samples)checksum+=c.historyCutoff(sample);if(i>=5)times.push(performance.now()-start);}times.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,samples:5000,emitters:2,maxExtraRetentionSeconds:maxExtraRetention,medianMs:times[5],p95Ms:times[10],checksum,scope:'Observed-clock mapping and history cutoff only. Original Python stats method validates 30-second expiry at the same conservative minimum print time; TS retains an extra 1 ms. No native cleanup, I/O or hardware timing.'},null,2));
