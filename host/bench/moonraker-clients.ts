import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {RemoteClients} from '../src/moonraker/clients.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
const root=process.env.MOONRAKER_SOURCE;if(!root)throw new Error('Set MOONRAKER_SOURCE');const pin=JSON.parse(readFileSync(new URL('../contracts/moonraker-upstream.json',import.meta.url),'utf8')).commit;
const types=['web','mobile','desktop','display','bot','agent','other'];
const params=(i:number)=>({client_name:`client-${i}`,version:'1.2.3',type:types[i%types.length].toUpperCase(),url:'https://example.test/client'});
const fixtures:Record<string,any>[]=[...Array.from({length:21},(_,i)=>params(i)),{}, {...params(1),type:'invalid'}];
const actual=fixtures.map((p,i)=>{const directory=new RemoteClients();directory.add(i+1);try{const result=directory.identify(i+1,p);return {result:{connection_id:result.id},identity:result.identity};}catch(error){return {error:(error as ApiError).status,identity:directory.get(i+1)!.identity};}});
const python=String.raw`
import ast,sys,json,asyncio,types,time,subprocess,logging
class ServerError(Exception):
 def __init__(self,message,status_code=400):self.status_code=status_code;super().__init__(message)
CLIENT_TYPES=['web','mobile','desktop','display','bot','agent','other']
def read(file):return subprocess.check_output(['git','-C',sys.argv[1],'show',sys.argv[2]+':'+file],text=True)
module=ast.parse(read('moonraker/components/websockets.py'));owner=next(n for n in module.body if isinstance(n,ast.ClassDef) and n.name=='WebsocketManager');methods=[n for n in owner.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in ('_handle_identify','get_clients_by_name','get_clients_by_type')]
exec('from __future__ import annotations\nclass Manager:\n'+__import__('textwrap').indent(ast.unparse(ast.Module(body=methods,type_ignores=[])),'    '),globals())
module=ast.parse(read('moonraker/components/extensions.py'));owner=next(n for n in module.body if isinstance(n,ast.ClassDef) and n.name=='ExtensionManager');method=next(n for n in owner.body if isinstance(n,ast.FunctionDef) and n.name=='register_agent');exec('from __future__ import annotations\nclass Extensions:\n'+__import__('textwrap').indent(ast.unparse(method),'    '),globals())
class Connection:
 def __init__(self,uid):self.uid=uid;self.identified=False;self._data={'name':'unknown','version':'','type':'','url':''}
 @property
 def client_data(self):return self._data
 @client_data.setter
 def client_data(self,value):self._data=value;self.identified=True
 def authenticate(self,**kwargs):pass
 def send_notification(self,*args):pass
class Request:
 def __init__(self,conn,params):self.conn=conn;self.params=params
 def get_client_connection(self):return self.conn
 def get_str(self,key,*default):
  if key not in self.params:
   if default:return default[0]
   raise ServerError('Missing argument')
  return str(self.params[key])
ext=Extensions();server=types.SimpleNamespace(error=ServerError,lookup_component=lambda name:ext,send_event=lambda *args:None);ext.server=server;ext.agents={};manager=Manager();manager.server=server;manager.clients={}
data=json.load(sys.stdin)
def params(i):return {'client_name':f'client-{i}','version':'1.2.3','type':CLIENT_TYPES[i%7].upper(),'url':'https://example.test/client'}
async def main():
 results=[]
 for i,p in enumerate(data['fixtures']):
  conn=Connection(i+1);ext.agents={}
  try:results.append({'result':await manager._handle_identify(Request(conn,p)),'identity':conn.client_data})
  except ServerError as error:results.append({'error':error.status_code,'identity':conn.client_data if conn.identified else None})
 samples=[];filters=[]
 for run in range(14):
  ext.agents={};manager.clients={};start=time.perf_counter()
  for i in range(10000):
   conn=Connection(i+1);manager.clients[conn.uid]=conn;await manager._handle_identify(Request(conn,params(i)))
  if run>=3:samples.append((time.perf_counter()-start)*1000)
 manager.clients={}
 for i in range(1000):
  c=Connection(i+1);c.client_data={'name':f'client-{i}','version':'1','type':CLIENT_TYPES[i%7],'url':''};manager.clients[c.uid]=c
 for run in range(14):
  start=time.perf_counter()
  for i in range(1000):manager.get_clients_by_name('CLIENT-1');manager.get_clients_by_type('WEB')
  if run>=3:filters.append((time.perf_counter()-start)*1000)
 print(json.dumps({'fixtures':results,'samples':sorted(samples),'filters':sorted(filters),'python':sys.version.split()[0]}))
asyncio.run(main())
`;
const reference=spawnSync(process.env.PYTHON??'/usr/bin/python3',['-c',python,root,pin],{input:JSON.stringify({fixtures}),encoding:'utf8',maxBuffer:4*1024*1024});if(reference.status!==0)throw new Error(reference.stderr);const result=JSON.parse(reference.stdout);assert.deepEqual(JSON.parse(JSON.stringify(actual)),result.fixtures);
const samples:number[]=[],filters:number[]=[];for(let run=0;run<14;run++){const directory=new RemoteClients(),start=performance.now();for(let i=0;i<10000;i++){directory.add(i+1);directory.identify(i+1,params(i));}if(run>=3)samples.push(performance.now()-start);}const directory=new RemoteClients();for(let i=0;i<1000;i++){directory.add(i+1);directory.identify(i+1,{client_name:`client-${i}`,version:'1',type:types[i%7],url:''});}
for(let run=0;run<14;run++){const start=performance.now();for(let i=0;i<1000;i++){directory.byName('CLIENT-1');directory.byType('WEB');}if(run>=3)filters.push(performance.now()-start);}samples.sort((a,b)=>a-b);filters.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,python:result.python,upstream:pin,fixtures:fixtures.length,identifications:10000,filterQueries:2000,filterClients:1000,nodeIdentifyMedianMs:samples[5],nodeIdentifyP95Ms:samples[10],pythonIdentifyMedianMs:result.samples[5],pythonIdentifyP95Ms:result.samples[10],nodeFilterMedianMs:filters[5],nodeFilterP95Ms:filters[10],pythonFilterMedianMs:result.filters[5],pythonFilterP95Ms:result.filters[10],scope:'Pinned WebsocketManager methods plus ExtensionManager.register_agent AST; inert authenticate/event/notification hooks. String-field contracts only. Both retain all live clients during identification. No JWT, extension method routing, network or printing claim.'},null,2));
