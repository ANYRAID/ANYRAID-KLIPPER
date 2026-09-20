import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {SubscriptionFilter,mergeSubscriptions,prepareStatus,adoptStatus,KlippyStatusCache} from '../src/moonraker/subscription-status.ts';
const root=process.env.MOONRAKER_SOURCE;if(!root)throw new Error('Set MOONRAKER_SOURCE');const pin=JSON.parse(readFileSync(new URL('../contracts/moonraker-upstream.json',import.meta.url),'utf8')).commit;
const changed=process.env.BENCH_CHANGED_FIELDS==='1',copyInput=process.env.BENCH_COPY_STATUS==='1';
const fixtures=[{previous:{toolhead:{x:1}},existing:[{toolhead:['x']},{toolhead:['velocity']}],requested:{toolhead:['x'],heater:[]},snapshot:{toolhead:{x:2,velocity:100},heater:{temperature:25}}},{previous:{toolhead:{x:2},removed:{x:1}},existing:[{toolhead:['x']}],requested:{toolhead:null},snapshot:{toolhead:{x:2,y:3}}},{previous:{value:{x:false,z:0,a:{x:1,y:2},list:[1,2]}},existing:[{value:null}],requested:{value:null},snapshot:{value:{x:0,z:0,a:{y:2,x:1},list:[2,1]}}},{previous:{configfile:{save_config_pending:false}},existing:[{configfile:null}],requested:{configfile:null},snapshot:{configfile:{config:{big:'x'},settings:{y:2},save_config_pending:true}}},{previous:{toolhead:{x:1}},existing:[{toolhead:null}],requested:{},snapshot:{toolhead:{x:3},missing:{x:9}}}];
const python=String.raw`
import ast,asyncio,copy,json,subprocess,sys,textwrap,time,types
source=subprocess.check_output(['git','-C',sys.argv[1],'show',sys.argv[2]+':moonraker/components/klippy_connection.py'],text=True);owner=next(n for n in ast.parse(source).body if isinstance(n,ast.ClassDef) and n.name=='KlippyConnection');methods=[n for n in owner.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in ('_process_status_update','_request_subscripton')];exec('from __future__ import annotations\nclass Manager:\n'+textwrap.indent(ast.unparse(ast.Module(body=methods,type_ignores=[])),'    '),globals())
import logging
CACHE_EXCLUSIONS={'configfile':['config','settings']}
class Client:
 def __init__(self):self.messages=[];self.count=0;self.capture=True
 def send_status(self,status,eventtime):
  if status:
   self.count+=1
   if self.capture:self.messages.append([status,eventtime])
class Request:
 def __init__(self,requested,client):self.args={'objects':copy.deepcopy(requested)};self.client=client
 def get_args(self):return self.args
 def get_subscribable(self):return self.client
data=json.load(sys.stdin)
async def main():
 results=[]
 for f in data['fixtures']:
  c=Manager();c.subscription_lock=asyncio.Lock();c.subscription_cache=copy.deepcopy(f['previous']);clients=[Client() for _ in f['existing']];c.subscriptions=dict(zip(clients,f['existing']));c.server=types.SimpleNamespace(error=RuntimeError);caller=Client();sent=[]
  async def standard(req,timeout):sent.append(copy.deepcopy(req.args));return {'status':copy.deepcopy(f['snapshot']),'eventtime':10}
  c._request_standard=standard;value=await c._request_subscripton(Request(f['requested'],caller));union=sent[0]['objects'];union={k:sorted(v) if v is not None else None for k,v in union.items()};results.append({'union':union,'status':value['status'],'cache':c.subscription_cache,'messages':[x.messages for x in clients]})
 c=Manager();c.subscription_cache={};clients=[Client() for _ in range(20)];c.subscriptions={client:{'toolhead':['position'],'heater':['temperature']} for client in clients}
 for client in clients:client.capture=False
 samples=[]
 for run in range(54):
  start=time.perf_counter()
  for i in range(1000):c._process_status_update(i*.1,{'toolhead':{'position':[i*.01,2,3],'velocity':100+(i*.001 if data['changed'] else 0)},'heater':{'temperature':200+(i*.01 if data['changed'] else 0)}})
  if run>=3:samples.append((time.perf_counter()-start)*1000)
 print(json.dumps({'fixtures':results,'samples':sorted(samples),'python':sys.version.split()[0],'deliveries':sum(c.count for c in clients)}))
asyncio.run(main())
`;
const child=spawnSync('/usr/bin/python3',['-c',python,root,pin],{input:JSON.stringify({fixtures,changed}),encoding:'utf8'});if(child.status!==0)throw new Error(child.stderr);const reference=JSON.parse(child.stdout);
const actual=fixtures.map(f=>{const existing=f.existing.map(s=>new SubscriptionFilter(s)),requested=new SubscriptionFilter(f.requested),cache=new KlippyStatusCache();cache.apply(prepareStatus(f.previous));const status=prepareStatus(f.snapshot),difference=cache.replace(status).difference,union=mergeSubscriptions([requested,...existing]).objects;return {union:Object.fromEntries(Object.entries(union).map(([k,v])=>[k,v===null?null:[...v].sort()])),status:requested.project(status,true),cache:cache.read(),messages:existing.map(filter=>{const projection=filter.project(difference);return Object.keys(projection).length?[[projection,10]]:[];})};});assert.deepEqual(JSON.parse(JSON.stringify(actual)),reference.fixtures);
const filters=Array.from({length:20},()=>new SubscriptionFilter({toolhead:['position'],heater:['temperature']})),cache=new KlippyStatusCache(),samples:number[]=[];let deliveries=0;
for(let run=0;run<54;run++){const start=performance.now();for(let i=0;i<1000;i++){const update=(copyInput?prepareStatus:adoptStatus)({toolhead:{position:[i*.01,2,3],velocity:100+(changed?i*.001:0)},heater:{temperature:200+(changed?i*.01:0)}});cache.apply(update);for(const filter of filters){const projected=filter.project(update);if(Object.keys(projected).length)deliveries++;}}if(run>=3)samples.push(performance.now()-start);}assert.equal(deliveries,reference.deliveries);samples.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,python:reference.python,upstream:pin,contracts:fixtures.length,changedScalarFields:changed,copyInput,samples:51,updates:1000,subscribers:20,nodeMedianMs:samples[25],nodeP95Ms:samples[48],pythonMedianMs:reference.samples[25],pythonP95Ms:reference.samples[48],scope:'Pinned subscription/request and status-update AST contracts with in-memory request replies and notification consumers. Hot loop includes preparation, immutable ownership (or explicit cloning with BENCH_COPY_STATUS=1), cache budgets and 20 projections in Node; Python uses original mutable cache and per-client dictionaries. No socket encoding, authorization fanout or printing-load acceptance.'},null,2));
