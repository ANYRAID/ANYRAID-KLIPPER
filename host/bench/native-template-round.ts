import {performance} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {NativeTemplateCandidate} from '../src/moonraker/native-template.ts';
const cases=[{v:true,p:0,m:'common'},{v:false,p:400,m:'floor'},{v:9007199254740991,p:1,m:'ceil'},{v:-9007199254740991,p:400,m:'floor'},{v:145,p:-1,m:'common'},{v:-155,p:-1,m:'common'},{v:2.675,p:2,m:'common'},{v:-2.675,p:2,m:'common'}];
const source='{% set d=payload|fromjson %}{set_result("x",d.v|round(d.p,d.m))}';
const child=spawnSync('python3',['-c',`
import json,sys,time
sys.path.insert(0,${JSON.stringify(fileURLToPath(new URL('../node_modules/.cache/jinja-reference',import.meta.url)))})
import jinja2
env=jinja2.Environment('{%','%}','{','}');env.filters['fromjson']=json.loads;t=env.from_string(${JSON.stringify(source)})
cases=json.loads(${JSON.stringify(JSON.stringify(cases))});payloads=[json.dumps(c) for c in cases];times=[];captured=None
expected=[]
def capture(name,value):
 global captured
 captured=dict(kind='integer' if isinstance(value,int) else 'float',value=value)
for payload in payloads:
 t.render(payload=payload,set_result=capture);expected.append(captured)
for run in range(9):
 start=time.perf_counter()
 for i in range(500):
  for payload in payloads:t.render(payload=payload,set_result=capture)
 if run>=2:times.append((time.perf_counter()-start)*1000)
 assert captured==expected[-1]
print(json.dumps(dict(times=times,expected=expected)))`],{encoding:'utf8',timeout:120000});assert.equal(child.status,0,child.stderr);
const reference=JSON.parse(child.stdout),t=new NativeTemplateCandidate(source),payloads=cases.map(c=>JSON.stringify(c)),times=[];
try{
 payloads.forEach((p,i)=>{const value=t.render(p)[0];assert.deepEqual({kind:value.numberType,value:value.numberValue},reference.expected[i]);});
 for(let run=0;run<9;run++){let value;const start=performance.now();for(let i=0;i<500;i++)for(const p of payloads)value=t.render(p)[0];if(run>=2)times.push(performance.now()-start);assert.deepEqual({kind:value!.numberType,value:value!.numberValue},reference.expected.at(-1));}
}finally{t.close();}
const summary=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[3],p95Ms:v[6]};};console.log(JSON.stringify({node:process.version,renders:4000,warmup:2,samples:7,scope:'Mixed integer, boolean and binary64 round inside native/Jinja templates; excludes MQTT, storage and printing',native:summary(times),python:summary(reference.times)},null,2));
