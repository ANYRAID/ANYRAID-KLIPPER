import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export function jobStateOracle(): string {
  const reference = JSON.parse(
    readFileSync(
      new URL('../../contracts/moonraker-job-state.json', import.meta.url),
      'utf8',
    ),
  );
  if (
    createHash('sha256').update(reference.source).digest('hex') !==
    reference.sourceSha256
  )
    throw new Error('Job state reference hash mismatch');
  const enums = reference.enumSource as string;
  const source = (reference.source as string).replace(
    'from ..common import JobEvent, KlippyState',
    '',
  );
  return `import json,sys,asyncio,copy,base64,time
from enum import Enum
exec(base64.b64decode('${Buffer.from(enums).toString('base64')}'))
exec(base64.b64decode('${Buffer.from(source).toString('base64')}'))
class Server:
 def register_event_handler(self,*args): pass
 def send_event(self,name,*args):
  if name=='job_state:state_changed': self.events.append(dict(kind='state',event=str(args[0]),previous=copy.deepcopy(args[1]),current=copy.deepcopy(args[2])))
  elif name=='job_state:layer_changed': self.events.append(dict(kind='layer',current=args[0],total=args[1]))
class Config:
 def get_server(self): return server
async def main():
 global server
 results=[]
 for case in json.load(sys.stdin):
  server=Server();server.events=[];job=JobState(Config());job.last_print_stats=case['initial']
  for delta in case['updates']: await job._status_update({'print_stats':delta},0.)
  if case.get('disconnect'): job._handle_disconnect()
  results.append(dict(events=server.events,stats=job.get_last_stats(),event=str(job.get_last_job_event())))
 print(json.dumps(results))
asyncio.run(main())
`;
}
