import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {SubscriptionManager} from '../src/moonraker/subscription-manager.ts';
import {KlippyStatusCache} from '../src/moonraker/subscription-status.ts';
const root=process.env.MOONRAKER_SOURCE;if(!root)throw new Error('Set MOONRAKER_SOURCE');const pin=JSON.parse(readFileSync(new URL('../contracts/moonraker-upstream.json',import.meta.url),'utf8')).commit;
const python=String.raw`
import ast,asyncio,copy,json,subprocess,sys,textwrap,time,types,logging
source=subprocess.check_output(['git','-C',sys.argv[1],'show',sys.argv[2]+':moonraker/components/klippy_connection.py'],text=True)
owner=next(n for n in ast.parse(source).body if isinstance(n,ast.ClassDef) and n.name=='KlippyConnection')
methods=[n for n in owner.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in ('_process_status_update','_request_subscripton')]
exec('from __future__ import annotations\nclass Manager:\n'+textwrap.indent(ast.unparse(ast.Module(body=methods,type_ignores=[])),'    '),globals())
CACHE_EXCLUSIONS={'configfile':['config','settings']}
class Client:
 def __init__(self):self.count=0
 def send_status(self,status,eventtime):
  if status:self.count+=1
class Request:
 def __init__(self,client,objects):self.client=client;self.args={'objects':objects}
 def get_args(self):return self.args
 def get_subscribable(self):return self.client
async def run():
 samples=[]
 for run in range(54):
  c=Manager();c.subscription_lock=asyncio.Lock();c.subscription_cache={};c.subscriptions={};c.server=types.SimpleNamespace(error=RuntimeError);clients=[Client() for _ in range(20)];i=0;last=None;union=None
  async def request(req,timeout):
   nonlocal union
   union=req.args['objects'];return {'status':{'toolhead':{'position':[i,2,3],'velocity':100+i}},'eventtime':i}
  c._request_standard=request;start=time.perf_counter()
  for i in range(200):last=await c._request_subscripton(Request(clients[i%20],{'toolhead':['position' if i%2 else 'velocity']}))
  if run>=3:samples.append((time.perf_counter()-start)*1000)
 print(json.dumps({'samples':sorted(samples),'last':last,'cache':c.subscription_cache,'deliveries':sum(client.count for client in clients),'union':{k:sorted(v) if v is not None else None for k,v in union.items()},'python':sys.version.split()[0]}))
asyncio.run(run())
`;
const child=spawnSync('/usr/bin/python3',['-c',python,root,pin],{encoding:'utf8'});if(child.status!==0)throw new Error(child.stderr);const reference=JSON.parse(child.stdout),samples:number[]=[];
for(let run=0;run<54;run++){let i=0,deliveries=0,last:unknown,union:any;const cache=new KlippyStatusCache(),manager=new SubscriptionManager({cache,request:async objects=>{union=objects;return {status:{toolhead:{position:[i,2,3],velocity:100+i}},eventtime:i};},deliver:()=>{deliveries++;}});const start=performance.now();for(i=0;i<200;i++)last=await manager.subscribe(i%20+1,{toolhead:[i%2?'position':'velocity']});if(run>=3)samples.push(performance.now()-start);assert.deepEqual(last,reference.last);assert.deepEqual(cache.read(),reference.cache);assert.equal(deliveries,reference.deliveries);assert.deepEqual(Object.fromEntries(Object.entries(union).map(([k,v])=>[k,v===null?null:[...(v as string[])].sort()])),reference.union);await manager.close();}
samples.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,python:reference.python,upstream:pin,samples:51,transactions:200,clients:20,nodeMedianMs:samples[25],nodeP95Ms:samples[48],pythonMedianMs:reference.samples[25],pythonP95Ms:reference.samples[48],scope:'Actual pinned subscription/status methods with in-memory async replies. Node includes bounded queue, cancellation ownership and immutable cache. Checks final reply/cache/union and delivery count each run; no authorization, wire encoding or printer deadline acceptance.'},null,2));
