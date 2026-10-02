import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {SensorStore} from '../src/moonraker/sensors.ts';
import {HistoryFields} from '../src/moonraker/history-fields.ts';
import {sensorOracle} from '../test/helpers/sensor-oracle.ts';
const definition={id:'room',type:'MQTT',capacity:1200,maxParameters:8,history:Array.from({length:8},(_,i)=>({name:String(i),parameter:String(i),description:'Reading',strategy:'average' as const}))};
const summarize=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[3],p95Ms:values[6]};};
const reference=spawnSync('python3',['-c',sensorOracle()+`
definition=json.loads(${JSON.stringify(JSON.stringify(definition))})
results={}
for mode in ['frames','samples','snapshots']:
 times=[]
 for run in range(9):
  h,s,fields=make_sensor(definition);h.active=True
  def render(context):
   for k in range(8):context['set_result'](str(k),float(i%128+k))
  s.state_response=types.SimpleNamespace(render=render)
  owner=Sensors.__new__(Sensors);owner.sensors={s.id:s};owner.server=types.SimpleNamespace(send_event=lambda *args:None)
  i=0;s._on_state_update(b'payload')
  for _ in range(1200):owner._update_sensor_values(0.)
  start=time.perf_counter()
  for i in range(1000 if mode=='snapshots' else 10000):
   if mode=='frames':s._on_state_update(b'payload')
   elif mode=='samples':owner._update_sensor_values(0.)
   else:json.dumps({s.id:s.get_sensor_measurements()},separators=(',',':'))
  if run>=2:times.append((time.perf_counter()-start)*1000)
 results[mode]=dict(times=times,info=s.get_sensor_info(True),measurements={s.id:s.get_sensor_measurements()},fields=[f.as_dict() for f in fields])
print(json.dumps(results))`],{encoding:'utf8',timeout:120000,maxBuffer:1000000});
assert.equal(reference.status,0,reference.stderr);const python=JSON.parse(reference.stdout),results=[];
for(const mode of ['frames','samples','snapshots']){
 const times=[];
 for(let run=0;run<9;run++){
  const fields=new HistoryFields(()=>true),store=new SensorStore();store.register(definition,fields);
  const frame=(i:number)=>Object.fromEntries(Array.from({length:8},(_,k)=>[String(k),{value:i%128+k}]));
  store.update('room',frame(0));for(let i=0;i<1200;i++)store.sample();
  const start=performance.now();
  for(let i=0;i<(mode==='snapshots'?1000:10000);i++){
   if(mode==='frames')store.update('room',frame(i));else if(mode==='samples')store.sample();else JSON.stringify(store.measurements());
  }
  if(run>=2)times.push(performance.now()-start);
  assert.deepEqual(store.info('room',true),python[mode].info);assert.deepEqual(store.measurements(),python[mode].measurements);assert.deepEqual(fields.snapshot().data,python[mode].fields);
 }
 results.push({mode,iterations:mode==='snapshots'?1000:10000,node:summarize(times),python:summarize(python[mode].times)});
}
console.log(JSON.stringify({node:process.version,parameters:8,capacity:1200,warmup:2,samples:7,scope:'Decoded frames with 8 history averages; MQTT and templates excluded',results},null,2));
