import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PrintLayerInfo} from '../src/gcode/print-layer-info.ts';
const commands:Record<string,string>[]=[{CURRENT_LAYER:'3'},{TOTAL_LAYER:'100'},{CURRENT_LAYER:'3'},{TOTAL_LAYER:'2'},{CURRENT_LAYER:'100'},{TOTAL_LAYER:'0'},{TOTAL_LAYER:'+1_0',CURRENT_LAYER:'９'},{TOTAL_LAYER:'-0'},{TOTAL_LAYER:'5',CURRENT_LAYER:'0'},{CURRENT_LAYER:'4'},{TOTAL_LAYER:'3',CURRENT_LAYER:'1'},{}];
const iterations=100000,python=String.raw`
import ast,json,sys,time
text=open(sys.argv[1]).read();node=next(n for n in ast.parse(text).body if isinstance(n,ast.ClassDef) and n.name=='PrintStats');exec(ast.get_source_segment(text,node),globals())
commands=json.loads(sys.argv[2]);iterations=int(sys.argv[3]);stats=PrintStats.__new__(PrintStats);stats.reset()
class Command:
 def __init__(self,params):self.params=params
 def get_int(self,name,default,minval=0):
  value=int(self.params[name]) if name in self.params else default
  if value is not None and value<minval:raise ValueError()
  return value
objects=[Command(c) for c in commands];results=[]
for c in objects:
 stats.cmd_SET_PRINT_STATS_INFO(c);results.append({'total_layer':stats.info_total_layer,'current_layer':stats.info_current_layer})
times=[];checksum=0
for run in range(14):
 stats.reset();start=time.perf_counter()
 for i in range(iterations):
  stats.cmd_SET_PRINT_STATS_INFO(objects[i%len(objects)]);checksum+=stats.info_current_layer or 0
 if run>=3:times.append((time.perf_counter()-start)*1e6/iterations)
print(json.dumps({'results':results,'times':sorted(times),'checksum':checksum}))
`;
const result=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/extras/print_stats.py',import.meta.url)),JSON.stringify(commands),String(iterations)],{encoding:'utf8',timeout:60000});if(result.status!==0)throw Error(result.stderr||String(result.error));const reference=JSON.parse(result.stdout),layers=new PrintLayerInfo();assert.deepEqual(commands.map(command=>{layers.update(command);return layers.status;}),reference.results);
let checksum=0;const times:number[]=[];for(let run=0;run<14;run++){layers.reset();const start=performance.now();for(let i=0;i<iterations;i++){layers.update(commands[i%commands.length]);checksum+=layers.status.current_layer??0;}if(run>=3)times.push((performance.now()-start)*1000/iterations);}times.sort((a,b)=>a-b);assert.equal(checksum,reference.checksum);
const limits={medianRatio:1.25,medianSlackUs:1,p95Ratio:1.5,p95SlackUs:2};console.log(JSON.stringify({node:process.version,iterations,warmup:3,samples:11,statesExact:true,checksum,python:{medianUs:reference.times[5],p95Us:reference.times[10]},nodeLayers:{medianUs:times[5],p95Us:times[10]},limits,scope:'Slicer layer integer conversion, defaults, clamp/reset and readback; executes repository Python PrintStats command as oracle. Excludes dispatch, network and physical printing.'}));assert(times[5]<=reference.times[5]*limits.medianRatio+limits.medianSlackUs);assert(times[10]<=reference.times[10]*limits.p95Ratio+limits.p95SlackUs);
