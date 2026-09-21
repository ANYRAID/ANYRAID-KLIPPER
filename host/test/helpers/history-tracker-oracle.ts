import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export function historyTrackerOracle():string{
 const ref=JSON.parse(readFileSync(new URL('../../contracts/moonraker-history-trackers.json',import.meta.url),'utf8'));
 if(createHash('sha256').update(ref.source).digest('hex')!==ref.sourceSha256)throw new Error('History tracker source hash mismatch');
 return `from __future__ import annotations
from typing import *
import json,sys,logging,time
_T=TypeVar('_T')
exec(${JSON.stringify('from __future__ import annotations\n'+ref.source)})
classes=dict(basic=BasicTracker,delta=DeltaTracker,accumulate=CumulativeTracker,average=AveragingTracker,maximum=MaximumTracker,minimum=MinimumTracker,collect=CollectionTracker)
class History:
 active=False
 paused=False
 def tracking_enabled(self,exclude):return self.active and not (exclude and self.paused)
def run(case):
 h=History();FieldTracker.class_init(h)
 t=classes[case['strategy']](exclude_paused=case.get('exclude',False))
 out=[]
 for op in case['ops']:
  kind=op['kind']
  if kind=='state':h.active=op['active'];h.paused=op['paused']
  elif kind=='update':t.update(op['value'])
  elif kind=='reset':
   t.set_reset_callback((lambda:op['value']) if 'value' in op else None)
   t.reset()
  out.append(dict(value=t.get_tracked_value(),totals=t.has_totals()))
  out[-1]=json.loads(json.dumps(out[-1]))
 return out
`;
}
