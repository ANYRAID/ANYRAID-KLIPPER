import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DisplayStatus} from '../src/gcode/display-status.ts';
const cases=[{p:null,t:0,active:false,file:.1},{p:'37.5',t:1,active:false,file:.2},{p:null,t:6,active:false,file:.3},{p:null,t:7,active:true,file:.4},{p:null,t:8,active:false,file:.5},{p:'-2',t:9,active:true,file:.6},{p:'150',t:10,active:true,file:.7},{p:null,t:16,active:false,file:.8},{p:'９_９',t:17,active:true,file:.9}];
const iterations=100000,python=String.raw`
import runpy,json,sys,time
Display=runpy.run_path(sys.argv[1])['DisplayStatus'];cases=json.loads(sys.argv[2]);iterations=int(sys.argv[3])
class Printer:
 def __init__(self):self.t=0.;self.active=False;self.file=0.
 def get_reactor(self):return self
 def monotonic(self):return self.t
 def lookup_object(self,name,default=None):
  owner=self
  class Object:
   def get_status(self,eventtime):return {'state':'Printing' if owner.active else 'Ready'} if name=='idle_timeout' else {'progress':owner.file}
  return Object()
class Command:
 def __init__(self,p):self.p=p
 def get_float(self,k,default=None):return float(self.p) if self.p is not None else default
 def get_raw_command_parameters(self):return '打印进度'
 def get(self,k,default=None):return '消息' if k=='MSG' else default
p=Printer();d=Display.__new__(Display);d.printer=p;d.expire_progress=0.;d.progress=d.message=None
results=[]
for c in cases:
 p.t=c['t'];p.active=c['active'];p.file=c['file'];d.cmd_M73(Command(c['p']));d.cmd_M117(Command(None));results.append(d.get_status(p.t))
command=Command('37.5');times=[];checksum=0.
for run in range(14):
 start=time.perf_counter()
 for i in range(iterations):
  p.t=i*.01;d.cmd_M73(command);d.cmd_SET_DISPLAY_TEXT(command);checksum+=d.get_status(p.t)['progress']
 if run>=3:times.append((time.perf_counter()-start)*1e6/iterations)
print(json.dumps({'results':results,'times':sorted(times),'checksum':checksum}))
`;
const p=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/extras/display_status.py',import.meta.url)),JSON.stringify(cases),String(iterations)],{encoding:'utf8',timeout:60000});if(p.status!==0)throw Error(p.stderr||String(p.error));const reference=JSON.parse(p.stdout);let now=0;const d=new DisplayStatus(()=>now);assert.deepEqual(cases.map(c=>{now=c.t;d.updateProgress(c.p===null?{}:{P:c.p});d.setMessage('打印进度');return d.status(c.t,c.active,c.file);}),reference.results);
const times:number[]=[];let checksum=0;for(let run=0;run<14;run++){const start=performance.now();for(let i=0;i<iterations;i++){now=i*.01;d.updateProgress({P:'37.5'});d.setMessage('消息');checksum+=d.status(now,false,0).progress;}if(run>=3)times.push((performance.now()-start)*1000/iterations);}times.sort((a,b)=>a-b);assert.equal(checksum,reference.checksum);
const limits={medianRatio:1.25,medianSlackUs:1,p95Ratio:1.5,p95SlackUs:2};assert(times[5]<=reference.times[5]*limits.medianRatio+limits.medianSlackUs);assert(times[10]<=reference.times[10]*limits.p95Ratio+limits.p95SlackUs);
console.log(JSON.stringify({node:process.version,cases:cases.length,statesExact:true,iterations,warmup:3,samples:11,checksum,nodeMedianUs:times[5],pythonMedianUs:reference.times[5],nodeP95Us:times[10],pythonP95Us:reference.times[10],limits,scope:'Progress conversion, text publication and snapshot; excludes dispatch, network and physical printing.'},null,2));
