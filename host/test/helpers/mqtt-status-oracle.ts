import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
/** Execute the actual pinned status methods, replacing only broker I/O. */
export function mqttStatusOracle():string{
 const contract=JSON.parse(readFileSync(new URL('../../contracts/moonraker-mqtt.json',import.meta.url),'utf8'));
 if(createHash('sha256').update(contract.source).digest('hex')!==contract.sourceSha256)throw new Error('MQTT reference hash mismatch');
 return `
import ast,json,time,types
from typing import Dict,Any
source=${JSON.stringify(contract.source)}
cls=next(n for n in ast.parse(source).body if isinstance(n,ast.ClassDef) and n.name=='MQTTClient')
methods=[n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name in ['send_status','_handle_timed_status_update','_publish_status_update']]
module=ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(name='Reference',bases=[],keywords=[],body=methods,decorator_list=[])],type_ignores=[]))
exec(compile(module,'mqtt.py','exec'))
def reference(split=False,interval=0,record=True):
 obj=Reference();obj.status_interval=interval;obj.publish_split_status=split;obj.status_cache={};obj.last_status_time=0
 obj.klipper_state_prefix='printer/klipper/state';obj.klipper_status_topic='printer/klipper/status';obj.is_connected=lambda:True;obj.frames=[];obj.count=0
 def publish(topic,payload,retain=False):
  encoded=json.dumps(payload,separators=(',',':'),ensure_ascii=False);obj.count+=1
  if record:obj.frames.append(dict(topic=topic,payload=json.loads(encoded),retain=retain))
 obj.publish_topic=publish
 return obj
`;
}
