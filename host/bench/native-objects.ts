import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {NativeObjects} from '../src/moonraker/native-objects.ts';
import type {Json} from '../src/moonraker/rpc.ts';
const data:Record<string,Record<string,Json>>={gcode_move:{position:[1.005,2.675,3,1e-9],gcode_position:[0,0,3,1e-9],speed:1500,speed_factor:1.5,absolute_coordinates:true,absolute_extrude:false},toolhead:{position:[1.005,2.675,3,1e-9],homed_axes:'xyz',axis_minimum:[0,0,0,0],axis_maximum:[300,300,250,0],max_velocity:300,max_accel:3000},extruder:{temperature:200.01,target:210,power:.5},heater_bed:{temperature:60,target:60,power:.25},heaters:{available_heaters:['extruder','heater_bed'],available_sensors:['extruder','heater_bed'],available_monitors:[]},fan:{speed:.75,rpm:null},native_host:{version:1,ready:true,group_state:'ready',hardware_state:'ready',print_state:'printing',mcus:[{id:'mcu',state:'ready'},{id:'aux',state:'ready'}]}};
const filters=[{},Object.fromEntries(Object.keys(data).map(n=>[n,null])),{gcode_move:['position','unknown'],missing:null,unknown:['field']},{toolhead:[],fan:['rpm','speed','speed']}];
const iterations=5000,dir=mkdtempSync(join(tmpdir(),'native-objects-bench-'));let oracle:{results:unknown[];timing:number[];checksum:number};
const python=String.raw`
import ast,contextlib,json,sys,time,types
text=open(sys.argv[1]).read();settings=json.load(open(sys.argv[2]));data=settings['data'];filters=settings['filters'];iterations=settings['iterations'];SUBSCRIPTION_REFRESH_TIME=.25
node=next(n for n in ast.parse(text).body if isinstance(n,ast.ClassDef) and n.name=='QueryStatusHelper');exec(ast.get_source_segment(text,node),globals())
reactor=types.SimpleNamespace(assert_no_pause=contextlib.nullcontext,unregister_timer=lambda t:None,NEVER=float('inf'))
printer=types.SimpleNamespace(get_reactor=lambda:reactor,lookup_object=lambda name,default=None:types.SimpleNamespace(get_status=lambda t:data[name]) if name in data else default)
helper=QueryStatusHelper.__new__(QueryStatusHelper);helper.printer=printer;helper.last_query={};helper.clients={};helper.query_timer=None
request=json.dumps(filters[1],separators=(',',':'))
def run(encoded):
 objects=json.loads(encoded)
 for key,fields in objects.items():
  if type(key)!=str or fields is not None and (type(fields)!=list or any(type(f)!=str for f in fields)):raise ValueError('Invalid filter')
 result=[];helper.pending_queries=[(None,objects,lambda message:result.append(message['params']),{})];helper._do_query(12.5)
 return json.dumps(result[0],separators=(',',':'))
results=[json.loads(run(json.dumps(f))) for f in filters];times=[];checksum=0
for sample in range(14):
 start=time.perf_counter()
 for i in range(iterations):checksum+=len(run(request))
 if sample>=3:times.append((time.perf_counter()-start)*1e6/iterations)
print(json.dumps({'results':results,'timing':sorted(times),'checksum':checksum}))
`;
try{const path=join(dir,'input.json');writeFileSync(path,JSON.stringify({data,filters,iterations}));const result=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/webhooks.py',import.meta.url)),path],{encoding:'utf8',timeout:60000,maxBuffer:4*1024**2});if(result.status!==0)throw new Error(result.stderr||String(result.error));oracle=JSON.parse(result.stdout);}finally{rmSync(dir,{recursive:true,force:true});}
const objects=new NativeObjects(new Map(Object.entries(data).map(([name,fields])=>[name,()=>fields])),()=>12.5);
assert.deepEqual(filters.map(filter=>JSON.parse(JSON.stringify(objects.query(filter)))),oracle.results);
const request=JSON.stringify(filters[1]),times:number[]=[];let checksum=0;
for(let sample=0;sample<14;sample++){const start=performance.now();for(let i=0;i<iterations;i++)checksum+=JSON.stringify(objects.query(JSON.parse(request))).length;if(sample>=3)times.push((performance.now()-start)*1000/iterations);}
times.sort((a,b)=>a-b);const timing=[{medianUs:oracle.timing[5],p95Us:oracle.timing[10]},{medianUs:times[5],p95Us:times[10]}],limits={medianRatio:1.25,medianSlackUs:5,p95Ratio:1.5,p95SlackUs:10};
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,iterations,variants:['pythonWebhooks','nativeObjects'],timing,limits,checksum,oracleChecksum:oracle.checksum,scope:'Decode object selection, validate, query seven objects and serialize response. Python executes repository QueryStatusHelper; excludes transport and physical printing. Four differential projection cases exact.'}));
assert(checksum>0);assert(times[5]<=oracle.timing[5]*limits.medianRatio+limits.medianSlackUs);assert(times[10]<=oracle.timing[10]*limits.p95Ratio+limits.p95SlackUs);
