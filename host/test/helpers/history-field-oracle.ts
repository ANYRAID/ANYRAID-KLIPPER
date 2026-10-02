import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {historyTrackerOracle} from './history-tracker-oracle.ts';
export function historyFieldOracle():string{
 const ref=JSON.parse(readFileSync(new URL('../../contracts/moonraker-history-fields.json',import.meta.url),'utf8'));
 if(createHash('sha256').update(ref.source).digest('hex')!==ref.sourceSha256)throw new Error('History field source hash mismatch');
 return historyTrackerOracle()+`
import types
class TrackingStrategy:
 @staticmethod
 def from_string(name):
  key=name.lower()
  return types.SimpleNamespace(name=key.upper(),get_tracker=lambda **kw:classes[key](**kw))
exec(${JSON.stringify('from __future__ import annotations\n'+ref.source)})
def typed(value,kind):
 return float(value) if type(value) in (int,float) and kind=='float' else value
def field_run(case):
 h=History();FieldTracker.class_init(h)
 field=HistoryFieldData('reading','sensor','Reading',case['strategy'],units='J',report_total=True,report_maximum=True,precision=case['precision'])
 out=[]
 for op in case['ops']:
  kind=op['kind']
  if kind=='state':h.active=op['active'];h.paused=op['paused']
  elif kind=='update':field.tracker.update(typed(op['value'],op.get('numberType','float')))
  elif kind=='pause':field.tracker.set_exclude_paused(op['exclude'])
  elif kind=='reset':
   field.tracker.set_reset_callback((lambda:typed(op['value'],op.get('numberType','float'))) if 'value' in op else None)
   field.tracker.reset()
  value=field.tracker.get_tracked_value()
  totals=[]
  if field.has_totals():totals=[dict(provider='sensor',field='reading',value=int(value) if isinstance(value,bool) else value,report_total=True,report_maximum=True,precision=case['precision'])]
  out.append(json.loads(json.dumps(dict(configuration=field.get_configuration(),snapshot=dict(data=[field.as_dict()],totals=totals)))))
 return out
`;
}
