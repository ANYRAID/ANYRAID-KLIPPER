import {performance} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {NativeSensorMessages} from '../src/moonraker/native-sensor-config.ts';
import {SensorStore} from '../src/moonraker/sensors.ts';
import {HistoryFields} from '../src/moonraker/history-fields.ts';
import {sensorOracle} from '../test/helpers/sensor-oracle.ts';
const definition={id:'room',type:'MQTT',history:[{name:'power',parameter:'power',description:'Reading',strategy:'average' as const}]};
const template='{% set d=payload|fromjson %}{set_result("power",d.power|float)}{set_result("voltage",d.voltage|float)}{set_result("current",d.current|float)}{set_result("energy",d.energy|float * 0.000001)}';
const payload='{"power":25.5,"voltage":230.0,"current":0.125,"energy":1200}';
const child=spawnSync('python3',['-c',sensorOracle()+`
import sys
sys.path.insert(0,${JSON.stringify(fileURLToPath(new URL('../node_modules/.cache/jinja-reference',import.meta.url)))})
import jinja2
env=jinja2.Environment('{%','%}','{','}');env.filters['fromjson']=json.loads
template=env.from_string(${JSON.stringify(template)})
definition=json.loads(${JSON.stringify(JSON.stringify(definition))});payload=${JSON.stringify(payload)}.encode();times=[]
for run in range(9):
 h,s,fields=make_sensor(definition);h.active=True;s.state_response=template
 start=time.perf_counter()
 for i in range(10000):s._on_state_update(payload)
 if run>=2:times.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(times=times,info=s.get_sensor_info(True),fields=[f.as_dict() for f in fields])))`],{encoding:'utf8',timeout:120000});
assert.equal(child.status,0,child.stderr);const reference=JSON.parse(child.stdout),times=[];
for(let run=0;run<9;run++){
 const fields=new HistoryFields(()=>true),store=new SensorStore();store.register(definition,fields);const receiver=new NativeSensorMessages(store,'room',template),bytes=Buffer.from(payload);
 try{const start=performance.now();for(let i=0;i<10000;i++)receiver.receive(bytes);if(run>=2)times.push(performance.now()-start);assert.equal(receiver.status.accepted,10000);assert.deepEqual(store.info('room',true),reference.info);assert.deepEqual(fields.snapshot().data,reference.fields);}finally{receiver.close();store.close();}
}
const summary=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[3],p95Ms:values[6]};};
console.log(JSON.stringify({node:process.version,frames:10000,warmup:2,samples:7,scope:'Byte decoding, original template syntax, typed JSON and four callbacks, SensorStore and average history; excludes MQTT and printing',native:summary(times),python:summary(reference.times)},null,2));
