// Run only the pinned upstream JsonRPC class with inert transport/handler doubles.
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
const root=process.env.MOONRAKER_SOURCE;
if(!root) throw new Error('Set MOONRAKER_SOURCE to a checkout containing the pinned upstream commit');
const pin=JSON.parse(readFileSync(new URL('../contracts/moonraker-upstream.json',import.meta.url),'utf8')).commit;
const source=spawnSync('git',['-C',root,'show',`${pin}:moonraker/common.py`],{encoding:'utf8',maxBuffer:4*1024*1024});
if(source.status!==0) throw new Error(source.stderr);
const requests=[
  '{"jsonrpc":"2.0","method":"echo","params":{"value":123,"enabled":true},"id":7}',
  '{"jsonrpc":"2.0","method":"echo","params":{},"id":0}',
  '{"jsonrpc":"2.0","method":"echo","params":{}}',
  '{"jsonrpc":"2.0","method":"missing"}',
  '{"jsonrpc":"2.0","method":"echo","params":[]}',
  '{"jsonrpc":"1.0","method":"echo","id":2}',
  '[]','[ {"jsonrpc":"2.0","method":"echo","id":3}, {"jsonrpc":"2.0","method":"missing","id":4} ]'
];
const python=String.raw`
import ast,sys,json,asyncio,time,types,logging
logging.disable(logging.CRITICAL)
source=open(sys.argv[1]).read(); tree=ast.parse(source)
node=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='JsonRPC')
class ServerError(Exception): pass
class AgentError(Exception): pass
class BaseRemoteConnection: pass
class Sentinel: MISSING=object()
jsonw=types.SimpleNamespace(loads=json.loads,dumps=lambda obj:json.dumps(obj,separators=(',',':')).encode())
exec('from __future__ import annotations\n'+ast.get_source_segment(source,node),globals())
class Server:
 def is_verbose_enabled(self):return False
class Definition:
 transports={'websocket'}
 async def request(self,params,*args):return params
class Transport:
 transport_type='websocket';ip_addr=None;user_info=None
 def screen_rpc_request(self,*args):pass
requests=json.load(open(sys.argv[2])); rpc=JsonRPC(Server());rpc.register_method('echo','GET',Definition());transport=Transport()
async def batch():
 for _ in range(10000):
  result=await rpc.dispatch(requests[0],transport)
  assert json.loads(result)['result']['value']==123
async def main():
 responses=[]
 for request in requests:
  response=await rpc.dispatch(request,transport)
  responses.append(None if response is None else json.loads(response))
 for _ in range(3):await batch()
 times=[]
 for _ in range(11):
  start=time.perf_counter();await batch();times.append((time.perf_counter()-start)*1000)
 print(json.dumps({'responses':responses,'times':sorted(times),'python':sys.version}))
asyncio.run(main())
`;
const dir=mkdtempSync(join(tmpdir(),'anyraid-rpc-oracle-'));
let oracle;
try {
  writeFileSync(join(dir,'common.py'),source.stdout);writeFileSync(join(dir,'requests.json'),JSON.stringify(requests));
  const run=spawnSync(process.env.PYTHON??'python3',['-c',python,join(dir,'common.py'),join(dir,'requests.json')],{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
  if(run.status!==0) throw new Error(run.stderr||String(run.error));oracle=JSON.parse(run.stdout);
} finally {rmSync(dir,{recursive:true,force:true});}
const rpc=new JsonRpcDispatcher();rpc.register('echo',['websocket'],p=>p);
const context={transport:'websocket' as const,signal:new AbortController().signal,authorize:()=>{}};
for(let i=0;i<requests.length;i++) {
  const result=await rpc.dispatch(requests[i],context);
  assert.deepEqual(result===null?null:JSON.parse(result),oracle.responses[i]);
}
async function batch():Promise<void> {
  for(let i=0;i<10000;i++) assert.equal(JSON.parse((await rpc.dispatch(requests[0],context))!).result.value,123);
}
for(let i=0;i<3;i++) await batch();
const times=[];
for(let i=0;i<11;i++) {const start=performance.now();await batch();times.push(performance.now()-start);}
times.sort((a,b)=>a-b);
console.log(JSON.stringify({upstream:pin,requestsCompared:requests.length,operations:10000,nodeMedianMs:times[5],pythonMedianMs:oracle.times[5],nodeP95Ms:times[10],pythonP95Ms:oracle.times[10],speedup:oracle.times[5]/times[5]},null,2));
assert.ok(times[5]<=oracle.times[5],'RPC dispatch slower than pinned upstream');
