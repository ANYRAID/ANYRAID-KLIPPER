import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import {mqttSubscriptionPayload} from '../src/moonraker/mqtt-api.ts';
const fixtures=['{"t":2.675,"power":25.5,"samples":[1,2,3],"enabled":true}','温度传感器在线','{"counter":"9007199254740993"}'],results=[],summary=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[3],p95Ms:v[6]};};
for(const payload of fixtures){
 const child=spawnSync('python3',['-c',`
import json,time
payload=${JSON.stringify(payload)}.encode('utf-8')
def decode(raw):
 try:return json.loads(raw)
 except json.JSONDecodeError:return raw.decode()
times=[]
for run in range(9):
 start=time.perf_counter()
 for i in range(100000):result=decode(payload)
 if run>=2:times.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(times=times,result=result)))`],{encoding:'utf8',timeout:120000});assert.equal(child.status,0,child.stderr);const ref=JSON.parse(child.stdout),bytes=Buffer.from(payload),times=[];
 for(let run=0;run<9;run++){let result;const start=performance.now();for(let i=0;i<100000;i++)result=mqttSubscriptionPayload(bytes);if(run>=2)times.push(performance.now()-start);assert.deepEqual(result,ref.result);}
 results.push({kind:payload.startsWith('{')?'json':'text',node:summary(times),python:summary(ref.times)});
}
console.log(JSON.stringify({node:process.version,decodes:100000,warmup:2,samples:7,scope:'UTF-8 JSON/text response decoding; Node includes precision and structure guards, Python stdlib follows upstream fallback; no network or printing',results},null,2));
