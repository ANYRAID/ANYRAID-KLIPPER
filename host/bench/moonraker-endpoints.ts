import {spawnSync,type SpawnSyncReturns} from 'node:child_process';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {EndpointRegistry,parseRestArguments,type RequestVerb} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type Transport} from '../src/moonraker/rpc.ts';
const root=process.env.MOONRAKER_SOURCE;if(!root)throw new Error('Set MOONRAKER_SOURCE');const pin=JSON.parse(readFileSync(new URL('../contracts/moonraker-upstream.json',import.meta.url),'utf8')).commit;
const definitions:{endpoint:string;methods:RequestVerb[];transports:Transport[];remote:boolean}[]=[];
for(const endpoint of ['/server/item','/machine/device/info','objects/query'])for(const methods of [['GET'],['POST','DELETE'],['GET','POST','DELETE']] as RequestVerb[][])for(const transports of [['http'],['websocket'],['http','websocket']] as Transport[][])definitions.push({endpoint,methods,transports,remote:endpoint==='objects/query'});
const fixtures=[
 {query:'speed:int=120&factor:float=1.25&enabled:bool=true',body:'',type:'',objects:false},
 {query:'v:int=1_200&f:float=1_000.5&off:bool=1&unknown:other=value&bad:int=no',body:'',type:'',objects:false},
 {query:'a=first&a=last&token=secret&access_token=secret&connection_id=3&_=4',body:'',type:'',objects:false},
 {query:'v=query',body:'v=body&more:int=2',type:'application/x-www-form-urlencoded',objects:false},
 {query:'v:int=1',body:'{"v":2,"nested":{"a":[1,2]}}',type:'application/json',objects:false},
 {query:'data:json=%7B%22list%22%3A%5B1%2C2%5D%7D',body:'',type:'',objects:false},
 {query:'toolhead=position,velocity&extruder=&token=secret',body:'',type:'',objects:true},
 {query:'toolhead=position',body:'{"objects":{"extruder":["temperature"]}}',type:'application/json',objects:true},
 {query:'a=%20%20hello%20world%20%20&flag:bool=FALSE',body:'{',type:'application/json',objects:false}
];
const input=fixtures.map(f=>({...f,bytes:Buffer.from(f.body)}));const results=input.map(f=>parseRestArguments(f.query,f.bytes,f.type,f.objects));
const python=String.raw`
import ast,sys,json,types,logging,textwrap,dataclasses,enum,re,time
from typing import ClassVar
from urllib.parse import parse_qs
logging.disable(logging.CRITICAL)
common=open(sys.argv[1]).read();application=open(sys.argv[2]).read();data=json.load(open(sys.argv[3]));jsonw=types.SimpleNamespace(loads=json.loads,JSONDecodeError=json.JSONDecodeError)
class ServerError(Exception):pass
EXCLUDED_ARGS=['_','token','access_token','connection_id'];ENDPOINT_PREFIXES=['printer','server','machine','access','api','debug']
class Flag(enum.Flag):
 @classmethod
 def from_string_list(cls,values):
  result=cls(0)
  for value in values:result|=getattr(cls,value.upper())
  return result
 @classmethod
 def all(cls):return cls.from_string_list([x.name for x in cls])
class RequestType(Flag):GET=enum.auto();POST=enum.auto();DELETE=enum.auto()
class TransportType(Flag):HTTP=enum.auto();WEBSOCKET=enum.auto();MQTT=enum.auto();INTERNAL=enum.auto()
node=next(n for n in ast.parse(common).body if isinstance(n,ast.ClassDef) and n.name=='APIDefinition');exec('from __future__ import annotations\n@dataclasses.dataclass(frozen=True)\n'+ast.get_source_segment(common,node),globals())
node=next(n for n in ast.parse(application).body if isinstance(n,ast.ClassDef) and n.name=='DynamicRequestHandler');names=['_convert_type','_default_parser','_object_parser','parse_args'];methods=[ast.get_source_segment(application,n) for n in node.body if isinstance(n,ast.FunctionDef) and n.name in names];exec('from __future__ import annotations\nclass Parser:\n'+textwrap.indent('\n'.join(methods),'    '),globals())
def parse(f):
 args=parse_qs(f['query'],keep_blank_values=True)
 if f['type'].startswith('application/x-www-form-urlencoded'):
  for k,v in parse_qs(f['body'],keep_blank_values=True).items():args.setdefault(k,[]).extend(v)
 p=Parser();p.request=types.SimpleNamespace(arguments=args,headers={'Content-Type':f['type']},body=f['body'].encode());p.get_argument=lambda k:re.sub(r'[\x00-\x08\x0e-\x1f]',' ',args[k][-1]).strip();p.api_defintion=types.SimpleNamespace(need_object_parser=f['objects']);p.path_kwargs={};return p.parse_args()
definitions=[]
for d in data['definitions']:
 APIDefinition._cache.clear();item=APIDefinition.create(d['endpoint'],d['methods'],None,d['transports'],is_remote=d['remote']);definitions.append({'path':item.http_path,'names':item.rpc_methods,'http':[v.name for v in item.request_types] if 'http' in d['transports'] else None})
results=[parse(f) for f in data['fixtures']];samples=[]
for repeat in range(14):
 t=time.perf_counter()
 for i in range(10000):parse(data['fixtures'][i%len(data['fixtures'])])
 if repeat>=3:samples.append((time.perf_counter()-t)*1000)
print(json.dumps({'results':results,'definitions':definitions,'samples':sorted(samples),'python':sys.version.split()[0]}))
`;
const dir=mkdtempSync(join(tmpdir(),'moonraker-endpoints-'));let reference:any;
try{for(const [file,path] of [['common.py','moonraker/common.py'],['application.py','moonraker/components/application.py']]){const r:SpawnSyncReturns<string>=spawnSync('git',['-C',root,'show',`${pin}:${path}`],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);writeFileSync(join(dir,file),r.stdout);}writeFileSync(join(dir,'input.json'),JSON.stringify({definitions,fixtures}));const run=spawnSync(process.env.PYTHON??'/usr/bin/python3',['-c',python,join(dir,'common.py'),join(dir,'application.py'),join(dir,'input.json')],{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});assert.equal(run.status,0,run.stderr||String(run.error));reference=JSON.parse(run.stdout);}finally{rmSync(dir,{recursive:true,force:true});}
assert.deepEqual(JSON.parse(JSON.stringify(results)),reference.results);
for(let i=0;i<definitions.length;i++){const rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc);registry.register(definitions[i],()=>null);const r:{path:string;names:string[];http:RequestVerb[]|null}=reference.definitions[i];assert.deepEqual(registry.allowed(r.path)??null,r.http);for(const name of r.names)assert.equal(rpc.has(name),true,JSON.stringify({definition:definitions[i],name}));}
const samples:number[]=[];for(let run=0;run<14;run++){const begin=performance.now();for(let i=0;i<10000;i++){const f=input[i%input.length];parseRestArguments(f.query,f.bytes,f.type,f.objects);}if(run>=3)samples.push(performance.now()-begin);}samples.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,python:reference.python,upstream:pin,definitions:definitions.length,fixtures:fixtures.length,operations:10000,nodeMedianMs:samples[5],nodeP95Ms:samples[10],pythonMedianMs:reference.samples[5],pythonP95Ms:reference.samples[10],scope:'Pinned APIDefinition and DynamicRequestHandler parser methods; in-memory form/query/JSON parsing, Python request doubles and stdlib JSON. Unsafe integer and non-object JSON policy differences tested separately.'},null,2));
