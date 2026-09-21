import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {historyFieldOracle} from './history-field-oracle.ts';
export function sensorOracle():string{
 const ref=JSON.parse(readFileSync(new URL('../../contracts/moonraker-sensor.json',import.meta.url),'utf8'));
 if(createHash('sha256').update(ref.source).digest('hex')!==ref.sourceSha256)throw new Error('Sensor source hash mismatch');
 return historyFieldOracle()+`
import ast,asyncio
from collections import defaultdict,deque
from functools import partial
tree=ast.parse(${JSON.stringify(ref.source)})
methods={'_gen_reset_callback','_update_sensor_value','get_sensor_info','get_sensor_measurements','_on_state_update','_on_mqtt_disconnected','_update_sensor_values'}
selected=[]
for n in tree.body:
 if isinstance(n,ast.FunctionDef) and n.name=='_set_result':selected.append(n)
 if isinstance(n,ast.ClassDef) and n.name in {'BaseSensor','MQTTSensor','Sensors'}:
  n.body=[f for f in n.body if isinstance(f,(ast.FunctionDef,ast.AsyncFunctionDef)) and f.name in methods];selected.append(n)
exec('from __future__ import annotations\\n'+ast.unparse(ast.Module(body=selected,type_ignores=[])))
SENSOR_EVENT_NAME='sensors:sensor_update';SENSOR_UPDATE_TIME=1.
def make_sensor(definition):
 h=History();FieldTracker.class_init(h)
 s=MQTTSensor.__new__(MQTTSensor);s.id=definition['id'];s.type=definition['type'];s.name=definition.get('name',s.id);s.error_state=None;s.last_measurements={};s.last_value={};s.values=defaultdict(lambda:deque(maxlen=definition.get('capacity',1200)));s.param_info=definition.get('parameters',[]);s.field_info={}
 registered=[]
 for d in definition.get('history',[]):
  cb=s._gen_reset_callback(d['parameter']) if d.get('initTracker') else None
  f=HistoryFieldData(d['name'],'sensor '+s.id,d['description'],d['strategy'],units=d.get('units'),reset_callback=cb,exclude_paused=d.get('excludePaused',False),report_total=d.get('reportTotal',False),report_maximum=d.get('reportMaximum',False),precision=d.get('precision'))
  registered.append(f);s.field_info.setdefault(d['parameter'],[]).append(f)
 return h,s,registered
def run_sensor(case):
 h,s,fields=make_sensor(case['definition']);events=[];out=[]
 owner=Sensors.__new__(Sensors);owner.sensors={s.id:s};owner.server=types.SimpleNamespace(send_event=lambda name,data:events.append(json.loads(json.dumps(data))))
 for op in case['ops']:
  if op['kind']=='frame':
   def render(context):
    for key,value in op['values'].items():context['set_result'](key,typed(value['value'],value.get('numberType','float')))
   s.state_response=types.SimpleNamespace(render=render);s._on_state_update(b'payload')
  elif op['kind']=='sample':owner._update_sensor_values(0.)
  elif op['kind']=='disconnect':asyncio.run(s._on_mqtt_disconnected())
  elif op['kind']=='start':
   for f in fields:f.tracker.reset()
   h.active=True;h.paused=False
  elif op['kind']=='pause':h.paused=op['paused']
  out.append(json.loads(json.dumps(dict(info=s.get_sensor_info(True),measurements={s.id:s.get_sensor_measurements()},history=[f.as_dict() for f in fields],events=events))))
 return out
`;
}
