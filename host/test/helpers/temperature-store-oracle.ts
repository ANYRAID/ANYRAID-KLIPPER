import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export function temperatureStoreOracle():string{
 const ref=JSON.parse(readFileSync(new URL('../../contracts/moonraker-data-store.json',import.meta.url),'utf8'));
 if(createHash('sha256').update(ref.source).digest('hex')!==ref.sourceSha256)throw new Error('Data store reference hash mismatch');
 return `import json,sys,asyncio,copy
exec(${JSON.stringify(ref.source.replace('from ..common import RequestType',''))})
class Timer:
 def start(self,**kwargs): pass
 def stop(self): pass
class API:
 async def query_objects(self,objects): return {'heaters':{'available_sensors':list(stage['sensors']),'available_monitors':list(stage['monitors'])}}
 async def subscribe_objects(self,objects): return stage['status']
class Server:
 error=RuntimeError
 def lookup_component(self,name): return API()
class Request:
 def __init__(self,include): self.include=include
 def get_boolean(self,*args): return self.include
async def main():
 global stage
 results=[]
 for case in json.load(sys.stdin):
  store=DataStore.__new__(DataStore);store.temp_store_size=case['capacity'];store.temperature_store={};store.temp_monitors=[];store.temp_update_timer=Timer();store.server=Server()
  snapshots=[]
  for stage in case['stages']:
   await store._init_sensors()
   for sample in stage['samples']:
    store.subscription_cache=sample
    store._update_temperature_store(0.)
   snapshots.append([await store._handle_temp_store_request(Request(False)),await store._handle_temp_store_request(Request(True))])
  results.append(snapshots)
 print(json.dumps(results))
asyncio.run(main())
`;
}
