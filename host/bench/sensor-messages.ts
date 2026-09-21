import {performance} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {SensorMessages} from '../src/moonraker/sensor-messages.ts';
import {SensorStore} from '../src/moonraker/sensors.ts';
import {HistoryFields} from '../src/moonraker/history-fields.ts';
import {sensorOracle} from '../test/helpers/sensor-oracle.ts';
const definition={id:'room',type:'MQTT',history:[{name:'temperature',parameter:'t',description:'Reading',strategy:'average' as const}]};
const child=spawnSync('python3',['-c',sensorOracle()+`\ndefinition=json.loads(${JSON.stringify(JSON.stringify(definition))})\ntimes=[]\nfor run in range(9):\n h,s,fields=make_sensor(definition);h.active=True\n def render(context):context['set_result']('t',context['payload'])\n s.state_response=types.SimpleNamespace(render=render)\n start=time.perf_counter()\n for i in range(100000):s._on_state_update(b'2.675')\n if run>=2:times.append((time.perf_counter()-start)*1000)\nprint(json.dumps(dict(times=times,info=s.get_sensor_info(True),fields=[f.as_dict() for f in fields])))`],{encoding:'utf8',timeout:120000});assert.equal(child.status,0,child.stderr);const ref=JSON.parse(child.stdout),times=[];
for(let run=0;run<9;run++){const fields=new HistoryFields(()=>true),store=new SensorStore();store.register(definition,fields);const source=new SensorMessages(store,'room',context=>context.setResult('t',context.payload)),payload=Buffer.from('2.675'),start=performance.now();for(let i=0;i<100000;i++)source.receive(payload);if(run>=2)times.push(performance.now()-start);assert.equal(source.status.accepted,100000);assert.deepEqual(store.info('room',true),ref.info);assert.deepEqual(fields.snapshot().data,ref.fields);source.close();store.close();}
const summary=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[3],p95Ms:v[6]};};
console.log(JSON.stringify({node:process.version,frames:100000,warmup:2,samples:7,scope:'UTF-8 decode, synchronous setter callback, numeric string conversion and average; excludes MQTT and Jinja',nodeResult:summary(times),python:summary(ref.times)},null,2));
