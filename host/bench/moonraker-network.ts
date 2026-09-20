import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
const pin=JSON.parse(readFileSync(new URL('../contracts/moonraker-upstream.json',import.meta.url),'utf8')).commit;
if(process.argv.includes('--server')){
 const rpc=new JsonRpcDispatcher();rpc.register('echo',['http','websocket'],p=>p);const endpoints=new EndpointRegistry(rpc);endpoints.register({endpoint:'/server/echo',methods:['GET','POST']},p=>p);const service=new MoonrakerNetwork(rpc,{endpoints,authorize(){}}),address=await service.listen();console.log(JSON.stringify({port:address.port,runtime:process.version}));process.once('SIGTERM',()=>{void service.close().then(()=>process.exit(0));});
}else{
 const root=process.env.MOONRAKER_SOURCE;if(!root)throw new Error('Set MOONRAKER_SOURCE to the pinned checkout; Python needs its pinned Tornado dependency');
 const python=String.raw`
import ast,sys,json,asyncio,time,types,logging,textwrap,signal,subprocess,ipaddress
import tornado,tornado.web,tornado.websocket,tornado.httpserver,tornado.netutil
logging.disable(logging.CRITICAL)
root,pin=sys.argv[1:3]
def source(path):return subprocess.check_output(['git','-C',root,'show',pin+':'+path],text=True)
common=source('moonraker/common.py');application=source('moonraker/components/application.py')
def cls(src,name):return next(n for n in ast.parse(src).body if isinstance(n,ast.ClassDef) and n.name==name)
class ServerError(Exception):pass
class AgentError(Exception):pass
class BaseRemoteConnection:pass
class Sentinel:MISSING=object()
jsonw=types.ModuleType('json_wrapper');exec(source('moonraker/utils/json_wrapper.py'),jsonw.__dict__)
exec('from __future__ import annotations\n'+ast.get_source_segment(common,cls(common,'JsonRPC')),globals())
class Server:
 def is_verbose_enabled(self):return False
 def lookup_component(self,name):return rpc
class Definition:
 transports={'http','websocket'}
 async def request(self,params,*args):return params
rpc=JsonRPC(Server());rpc.register_method('echo','GET',Definition())
class HTTP(tornado.web.RequestHandler):
 transport_type='http';ip_addr=None;user_info=None;server=Server()
 def screen_rpc_request(self,*args):pass
post=next(n for n in cls(application,'RPCHandler').body if isinstance(n,ast.AsyncFunctionDef) and n.name=='post')
ns={};exec('from __future__ import annotations\n'+textwrap.dedent(ast.get_source_segment(application,post)),globals(),ns);HTTP.post=ns['post']

RequestType=types.SimpleNamespace(GET='GET',POST='POST',DELETE='DELETE');EXCLUDED_ARGS=['_','token','access_token','connection_id'];parse_ip_address=ipaddress.ip_address
names=['_convert_type','_default_parser','_object_parser','parse_args','_process_http_request'];dynamic=cls(application,'DynamicRequestHandler');methods=[ast.get_source_segment(application,n) for n in dynamic.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in names]
exec('from __future__ import annotations\nclass REST(HTTP):\n'+textwrap.indent('\n'.join(methods),'    '),globals())
REST.api_defintion=types.SimpleNamespace(endpoint='/server/echo',request_types={'GET','POST'},need_object_parser=False,request=Definition().request);REST.wrap_result=True;REST.content_type=None;REST.get_associated_websocket=lambda self:None;REST._log_debug=lambda *args:None
async def rest_get(self):await self._process_http_request('GET')
async def rest_post(self):await self._process_http_request('POST')
REST.get=rest_get;REST.post=rest_post
class WS(tornado.websocket.WebSocketHandler):
 transport_type='websocket';ip_addr=None;user_info=None
 def screen_rpc_request(self,*args):pass
 def open(self):self.set_nodelay(True)
 def on_message(self,message):asyncio.create_task(self.process(message))
 async def process(self,message):
  result=await rpc.dispatch(message,self)
  if result is not None:await self.write_message(result.decode() if isinstance(result,bytes) else result)
async def main():
 app=tornado.web.Application([(r'/server/jsonrpc',HTTP),(r'/websocket',WS),(r'/server/echo',REST)],websocket_max_message_size=1024*1024)
 server=tornado.httpserver.HTTPServer(app);sockets=tornado.netutil.bind_sockets(0,'127.0.0.1');server.add_sockets(sockets)
 print(json.dumps({'port':sockets[0].getsockname()[1],'runtime':sys.version.split()[0],'tornado':tornado.version,'msgspec':jsonw.MSGSPEC_ENABLED}),flush=True)
 end=asyncio.Event();asyncio.get_running_loop().add_signal_handler(signal.SIGTERM,end.set);await end.wait();server.stop();await server.close_all_connections()
asyncio.run(main())
`;
 const children:ChildProcess[]=[];
 async function start(command:string,args:string[]){const child=spawn(command,args,{stdio:['ignore','pipe','pipe'],env:process.env});children.push(child);let error='';child.stderr!.on('data',d=>{if(error.length<8192)error+=String(d);if(process.env.BENCH_DEBUG)process.stderr.write(d);});const info=await new Promise<{port:number;runtime:string;tornado?:string;msgspec?:boolean}>((resolve,reject)=>{let data='';const timeout=setTimeout(()=>reject(new Error('Oracle startup timed out: '+error)),10000);child.once('error',e=>{clearTimeout(timeout);reject(e);});child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Oracle exited: '+error));});child.stdout!.on('data',chunk=>{data+=String(chunk);if(data.includes('\n')){clearTimeout(timeout);try{resolve(JSON.parse(data.split('\n')[0]));}catch(e){reject(e);}}});});return info;}
 try{
  const servers=[await start(process.execPath,[fileURLToPath(import.meta.url),'--server']),await start(process.env.PYTHON??'/usr/bin/python3',['-c',python,root,pin])];
  const sockets:WebSocket[]=[],pending=new Map<number,{resolve:(v:any)=>void;reject:(e:unknown)=>void;timer:ReturnType<typeof setTimeout>}>();let next=1;
  for(const info of servers){const ws=new WebSocket(`ws://127.0.0.1:${info.port}/websocket`);await once(ws,'open');ws.on('message',raw=>{const reply=JSON.parse(String(raw)),p=pending.get(reply.id);if(!p)return;clearTimeout(p.timer);pending.delete(reply.id);p.resolve(reply);});sockets.push(ws);}
  const call=(index:number)=>new Promise<any>((resolve,reject)=>{const id=next++,timer=setTimeout(()=>{pending.delete(id);reject(new Error('RPC round trip timeout'));},3000);pending.set(id,{resolve,reject,timer});sockets[index].send(JSON.stringify({jsonrpc:'2.0',method:'echo',params:{value:123},id}));});
  const fixtures=['{','[]',JSON.stringify({jsonrpc:'2.0',method:'echo',params:{value:123},id:7}),JSON.stringify({jsonrpc:'2.0',method:'echo',params:{}}),JSON.stringify({jsonrpc:'2.0',method:'missing',id:8}),JSON.stringify({jsonrpc:'2.0',method:'echo',params:[],id:9})];
  for(const body of fixtures){const results=[];for(const info of servers){const response=await fetch(`http://127.0.0.1:${info.port}/server/jsonrpc`,{method:'POST',headers:{'content-type':'application/json'},body});const text=await response.text();results.push({status:response.status,body:text?JSON.parse(text):null});}assert.deepEqual(results[0],results[1]);}
  const nullResults=[];for(const info of servers){const r=await fetch(`http://127.0.0.1:${info.port}/server/jsonrpc`,{method:'POST',headers:{'content-type':'application/json'},body:'null'});nullResults.push({status:r.status,body:await r.text()});}assert.equal(JSON.parse(nullResults[0].body).error.code,-32600);assert.equal(nullResults[1].status,500);
  for(const query of ['value:int=123','v:float=1.25&flag:bool=true','a=first&a=last&token=secret']){const replies=[];for(const info of servers){const r=await fetch(`http://127.0.0.1:${info.port}/server/echo?${query}`);replies.push(await r.json());}assert.deepEqual(replies[0],replies[1]);}
  const times=servers.map(()=>({rest:[] as number[],http:[] as number[],websocket:[] as number[],concurrent:[] as number[]}));
  const sampleCount=Number(process.env.BENCH_SAMPLES??11);if(!Number.isSafeInteger(sampleCount)||sampleCount<11||sampleCount>101)throw new Error('BENCH_SAMPLES must be an integer between 11 and 101');
  for(let run=0;run<sampleCount+3;run++)for(const index of run%2?[1,0]:[0,1]){
   let begin=performance.now();for(let i=0;i<200;i++){const response=await fetch(`http://127.0.0.1:${servers[index].port}/server/echo?value:int=123`);assert.equal((await response.json() as any).result.value,123);}if(run>=3)times[index].rest.push(performance.now()-begin);
   begin=performance.now();for(let i=0;i<200;i++){const response=await fetch(`http://127.0.0.1:${servers[index].port}/server/jsonrpc`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',method:'echo',params:{value:123},id:1})});assert.equal((await response.json() as any).result.value,123);}if(run>=3)times[index].http.push(performance.now()-begin);
   begin=performance.now();for(let i=0;i<500;i++)assert.equal((await call(index)).result.value,123);if(run>=3)times[index].websocket.push(performance.now()-begin);
   begin=performance.now();for(let i=0;i<20;i++){const results=await Promise.all(Array.from({length:16},()=>call(index)));assert.ok(results.every(r=>r.result.value===123));}if(run>=3)times[index].concurrent.push(performance.now()-begin);
  }
  for(const ws of sockets)ws.terminate();const metrics=times.map(t=>Object.fromEntries(Object.entries(t).map(([name,values])=>{values.sort((a,b)=>a-b);return [name,{medianMs:values[Math.floor((sampleCount-1)/2)],p95Ms:values[Math.ceil(sampleCount*.95)-1],maxMs:values[sampleCount-1]}];})));
  console.log(JSON.stringify({upstream:pin,servers,fixtures:fixtures.length,expectedDifference:'Top-level null: Node returns JSON-RPC Invalid Request; upstream dispatcher throws and its HTTP handler returns 500.',restFixtures:3,perSample:{rest:200,http:200,websocket:500,concurrent:320,concurrency:16},samples:sampleCount,node:metrics[0],python:metrics[1],scope:'Separate Node and Python server processes, same Node client. Python uses pinned JsonRPC, RPCHandler.post and DynamicRequestHandler REST processing with Tornado 6.5.8, upstream JSON wrapper and TCP_NODELAY; authorization/business handlers are inert. Not full Moonraker or printing-load acceptance.'},null,2));
 }finally{await Promise.all(children.map(child=>new Promise<void>(resolve=>{if(child.exitCode!==null){resolve();return;}const kill=setTimeout(()=>child.kill('SIGKILL'),2000);child.once('exit',()=>{clearTimeout(kill);resolve();});child.kill('SIGTERM');})));}
}
