import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
/** Execute the pinned upstream methods unchanged; only isolate component wiring. */
export function gcodeStoreOracle():string{
 const ref=JSON.parse(readFileSync(new URL('../../contracts/moonraker-data-store.json',import.meta.url),'utf8'));
 if(createHash('sha256').update(ref.source).digest('hex')!==ref.sourceSha256)throw new Error('Data store reference hash mismatch');
 const source=ref.source.replace('from ..common import RequestType','');
 return `import json,sys,asyncio,time
exec(${JSON.stringify(source)})
class Request:
 def __init__(self,count): self.count=count
 def get_int(self,key,default): return default if self.count is None else int(self.count)
async def main():
 results=[]
 for case in json.load(sys.stdin):
  store=DataStore.__new__(DataStore);store.gcode_queue=deque(maxlen=case['capacity'])
  for entry in case['entries']:
   time.time=lambda:entry['time']
   if entry['type']=='command': store._store_gcode_command(entry['message'])
   else: store._update_gcode_store(entry['message'])
  results.append([await store._handle_gcode_store_request(Request(count)) for count in case['counts']])
 print(json.dumps(results))
asyncio.run(main())
`;
}
