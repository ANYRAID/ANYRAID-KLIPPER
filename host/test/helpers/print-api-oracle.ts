import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export function printApiOracle():string{
 const pin=JSON.parse(readFileSync(new URL('../../contracts/moonraker-klippy-apis.json',import.meta.url),'utf8'));
 if(pin.commit!=='1cfb0c41e468645951a371621f06d32777b6107c'||createHash('sha256').update(pin.source).digest('hex')!==pin.sourceSha256)throw new Error('Print API source pin mismatch');
 return `source=${JSON.stringify(pin.source)}\n`+String.raw`
import ast,asyncio,json,sys,logging,time
logging.disable(logging.CRITICAL)
from types import SimpleNamespace
class Sentinel: MISSING=object()
tree=ast.parse(source)
original=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='KlippyAPI')
methods=[n for n in original.body if isinstance(n,ast.AsyncFunctionDef) and n.name in ('start_print','pause_print','resume_print','cancel_print')]
exec('from __future__ import annotations\nclass Subject:\n'+''.join('\n'.join('    '+line for line in ast.get_source_segment(source,n).splitlines())+'\n' for n in methods))
async def main():
 data=json.load(sys.stdin);subject=Subject();calls=[]
 async def send(method,params,default=None):
  if not data.get('count'): calls.append([method,params])
  return 'ok'
 async def run(script):return await send('gcode/script',{'script':script})
 subject.run_gcode=run;subject._send_klippy_request=send;subject.server=SimpleNamespace(send_event=lambda *args:None)
 async def action(item):
  if item['action']=='start':return await subject.start_print(item['filename'])
  return await getattr(subject,item['action']+'_print')()
 if data.get('count'):
  samples=[]
  for r in range(9):
   t=time.perf_counter()
   for i in range(data['count']):await action(data['cases'][i%len(data['cases'])])
   elapsed=(time.perf_counter()-t)*1000
   if r>=2:samples.append(elapsed)
  print(json.dumps({'roundsMs':samples,'medianMs':sorted(samples)[3],'p95Ms':sorted(samples)[6]}))
 else:
  for item in data['cases']:await action(item)
  print(json.dumps(calls))
asyncio.run(main())
`;
}
