import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {once} from 'node:events';
import {performance} from 'node:perf_hooks';
import {WebSocket} from 'ws';
import {RemoteClients} from '../src/moonraker/clients.ts';
import {JsonRpcDispatcher,type Json,type RpcContext} from '../src/moonraker/rpc.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {registerExtensions} from '../src/moonraker/extensions.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
const root=process.env.MOONRAKER_SOURCE;if(!root)throw new Error('Set MOONRAKER_SOURCE');const pin=JSON.parse(readFileSync(new URL('../contracts/moonraker-upstream.json',import.meta.url),'utf8')).commit;
const samples=Number(process.env.BENCH_SAMPLES??51);if(!Number.isSafeInteger(samples)||samples<11||samples>101)throw new Error('Invalid sample count');
const fixtures=[{method:'list',params:{}},{method:'call',params:{agent:'worker',method:'echo'}},{method:'call',params:{agent:'worker',method:'echo',arguments:[1,'x']}},{method:'call',params:{agent:'worker',method:'echo',arguments:{position:[1,2,3]}}},{method:'call',params:{agent:'missing',method:'echo'}},{method:'call',params:{agent:'worker',method:'echo',arguments:true}},{method:'event',params:{event:'progress',data:{percent:50}}},{method:'event',params:{event:'progress',data:false}},{method:'event',params:{event:'progress',data:null}},{method:'event',params:{event:'connected'}},{method:'event',params:{event:'disconnected'}}];
const python=String.raw`
import ast,asyncio,json,subprocess,sys,textwrap,types
source=subprocess.check_output(['git','-C',sys.argv[1],'show',sys.argv[2]+':moonraker/components/extensions.py'],text=True);owner=next(n for n in ast.parse(source).body if isinstance(n,ast.ClassDef) and n.name=='ExtensionManager');methods=[n for n in owner.body if isinstance(n,ast.AsyncFunctionDef) and n.name in ('_handle_list_extensions','_handle_call_agent','_handle_agent_event')]
class ServerError(Exception):
 def __init__(self,message,status=400):self.status=status;super().__init__(message)
exec('from __future__ import annotations\nclass Manager:\n'+textwrap.indent(ast.unparse(ast.Module(body=methods,type_ignores=[])),'    '),globals())
class Agent:
 uid=1;client_data={'name':'worker','version':'1','type':'agent','url':''}
 async def call_method_with_response(self,method,args):return {'method':method,'arguments':args}
 def send_notification(self,name,args):events.append({'method':'notify_'+name,'params':args,'excluded':[self.uid]})
class Request:
 def __init__(self,p):self.p=p
 def get_str(self,key):
  if key not in self.p:raise ServerError('Missing argument')
  return str(self.p[key])
 def get(self,key,default=None):return self.p.get(key,default)
 def get_client_connection(self):return agent
agent=Agent();manager=Manager();manager.server=types.SimpleNamespace(error=ServerError);manager.agents={'worker':agent};events=[]
async def main():
 results=[]
 for f in json.load(sys.stdin):
  events.clear()
  try:result={'result':await getattr(manager,{'list':'_handle_list_extensions','call':'_handle_call_agent','event':'_handle_agent_event'}[f['method']])(Request(f['params']))}
  except ServerError as error:result={'error':error.status}
  results.append({**result,'events':events[:]})
 print(json.dumps(results))
asyncio.run(main())
`;
const child=spawnSync('/usr/bin/python3',['-c',python,root,pin],{input:JSON.stringify(fixtures),encoding:'utf8'});if(child.status!==0)throw new Error(child.stderr);
const rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc),clients=new RemoteClients(),events:Json[]=[],context:RpcContext={transport:'websocket',signal:new AbortController().signal,connectionId:1,authorize(){}};
clients.add(1);clients.identify(1,{client_name:'worker',version:'1',type:'agent',url:''});const release=registerExtensions(registry,{getClient:id=>clients.get(id),getAgent:name=>clients.agent(name),getAgents:()=>clients.agents(),requestClient:async(_id,method,args)=>({method,arguments:args}),broadcast:async(method,params,excluded)=>{events.push({method,params:[...params],excluded:[...excluded]});}});
const actual=[];for(const f of fixtures){events.length=0;const method=f.method==='list'?'server.extensions.list':f.method==='call'?'server.extensions.request':'server.connection.send_event';const response=JSON.parse((await rpc.dispatch(JSON.stringify({jsonrpc:'2.0',id:1,method,params:f.params}),context))!);actual.push({...response.error?{error:response.error.code}:{result:response.result},events:[...events]});}assert.deepEqual(actual,JSON.parse(child.stdout));release();
const network=new MoonrakerNetwork(rpc,{endpoints:registry,authorize(){},authorizeClientRequest(){},authorizeNotification(){}}),releaseLive=registerExtensions(registry,network),address=await network.listen(),url=`http://127.0.0.1:${address.port}`,agent=new WebSocket(url.replace('http:','ws:')+'/websocket'),caller=new WebSocket(url.replace('http:','ws:')+'/websocket');let resolveCall:((value:any)=>void)|undefined,resolveAgent:((value:any)=>void)|undefined;
const timings:Record<string,number[]>={rpc:[],rpcControl:[],rest:[],restControl:[],list:[],listControl:[],event:[],eventControl:[]};
try{await Promise.all([once(agent,'open'),once(caller,'open')]);agent.on('message',data=>{const m=JSON.parse(String(data));if(m.method&&!m.method.startsWith('notify_'))agent.send(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.params??null}));else if(!m.method)resolveAgent?.(m);});const identified=once(agent,'message');agent.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'server.connection.identify',params:{client_name:'worker',version:'1',type:'agent',url:''}}));await identified;const id=network.getAgent('worker')!.id;
 registry.register({endpoint:'/server/extensions/control',methods:['POST']},(p,_v,c)=>network.requestClient(id,'echo',p.arguments as {[key:string]:Json},{signal:c.signal}));registry.register({endpoint:'/server/extensions/list_control',methods:['GET']},()=>({agents:network.getClientsByType('agent').map(c=>({...c.identity!}))}));registry.register({endpoint:'/server/connection/send_event_control',methods:['POST'],transports:['websocket']},async(p)=>{await network.broadcast('notify_agent_event',[{agent:'worker',event:p.event,data:p.data}],[id]);return 'ok';});caller.on('message',data=>{const m=JSON.parse(String(data));if(!m.method)resolveCall?.(m);});
 for(let run=0;run<samples+3;run++)for(const transport of ['rpc','rest'])for(const control of run%2?[true,false]:[false,true]){const method=control?'control':'request',n=transport==='rpc'?500:200,start=performance.now();for(let i=0;i<n;i++){const params={agent:'worker',method:'echo',arguments:{position:[1,2,3],velocity:125.5}};if(transport==='rpc'){const response=await new Promise<any>(resolve=>{resolveCall=resolve;caller.send(JSON.stringify({jsonrpc:'2.0',id:i+1,method:'server.extensions.'+method,params}));});assert.deepEqual(response.result,params.arguments);}else{const response=await fetch(url+'/server/extensions/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(params)});assert.equal(response.status,200);assert.deepEqual((await response.json() as any).result,params.arguments);}}if(run>=3)timings[transport+(control?'Control':'')].push(performance.now()-start);}
 for(let run=0;run<samples+3;run++)for(const mode of ['list','event'])for(const control of run%2?[true,false]:[false,true]){const start=performance.now();for(let i=0;i<500;i++){const result=await new Promise<any>(resolve=>{if(mode==='event'){resolveAgent=resolve;agent.send(JSON.stringify({jsonrpc:'2.0',id:i+10,method:'server.connection.send_event'+(control?'_control':''),params:{event:'progress',data:{percent:i}}}));}else{resolveCall=resolve;caller.send(JSON.stringify({jsonrpc:'2.0',id:i+10,method:'server.extensions.list'+(control?'_control':'')}));}});if(mode==='event')assert.equal(result.result,'ok');else assert.equal(result.result.agents[0].name,'worker');}if(run>=3)timings[mode+(control?'Control':'')].push(performance.now()-start);}
}finally{agent.terminate();caller.terminate();await network.close();releaseLive();}
function stats(values:number[]){values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(values.length/2)],p95Ms:values[Math.ceil(values.length*.95)-1],maxMs:values.at(-1)};}
console.log(JSON.stringify({node:process.version,upstream:pin,fixtures:fixtures.length,samples,results:Object.fromEntries(Object.entries(timings).map(([k,v])=>[k,stats(v)])),scope:'11 contracts against pinned ExtensionManager AST. Real localhost agent plus caller; 500 WebSocket or 200 REST forwarded round trips. Alternating extension handler versus direct fixed-agent forwarding through the same registry and authorization. Additionally 500 list RPCs versus a client-filter control and 500 event acknowledgements versus direct broadcast. Event acknowledgements are not observer receipt proof. Not full Python daemon, target board or printing-load acceptance.'},null,2));
