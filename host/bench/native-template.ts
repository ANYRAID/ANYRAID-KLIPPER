import {performance} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {NativeTemplateCandidate} from '../src/moonraker/native-template.ts';
const source='{% set notification = payload|fromjson %}{set_result("power", notification["apower"]|float)}{set_result("voltage", notification["voltage"]|float)}{set_result("current", notification["current"]|float)}{set_result("energy", notification["aenergy"]["by_minute"][0]|float * 0.000001)}';
const payload='{"apower":25.5,"voltage":230.0,"current":0.125,"aenergy":{"by_minute":[1200]}}';
const child=spawnSync('python3',['-c',`
import sys,json,time
sys.path.insert(0,${JSON.stringify(fileURLToPath(new URL('../node_modules/.cache/jinja-reference',import.meta.url)))})
import jinja2
env=jinja2.Environment('{%','%}','{','}');env.filters['fromjson']=json.loads;template=env.from_string(${JSON.stringify(source)});payload=${JSON.stringify(payload)};values={};times=[]
def capture(name,value):values[name]=value
for run in range(9):
 start=time.perf_counter()
 for i in range(3000):template.render(payload=payload,set_result=capture)
 if run>=2:times.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(times=times,values=values)))`],{encoding:'utf8',timeout:120000});assert.equal(child.status,0,child.stderr);const reference=JSON.parse(child.stdout),template=new NativeTemplateCandidate(source),times=[];
try{for(let run=0;run<9;run++){let values;const start=performance.now();for(let i=0;i<3000;i++)values=template.render(payload);if(run>=2)times.push(performance.now()-start);assert.deepEqual(Object.fromEntries(values!.map(value=>[value.name,value.numberValue])),reference.values);assert.ok(values!.every(value=>value.numberType==='float'));}}finally{template.close();}
const summary=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[3],p95Ms:values[6]};};console.log(JSON.stringify({node:process.version,engine:'minijinja-2.24.0 via N-API',rust:'1.89.0',renders:3000,warmup:2,samples:7,scope:'Original Moonraker Shelly syntax, native typed JSON/filters/readings versus Jinja2; no MQTT or SensorStore',native:summary(times),python:summary(reference.times)},null,2));
