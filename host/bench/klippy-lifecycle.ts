import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createServer,type Socket} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {KlippyLifecycle} from '../src/moonraker/klippy-lifecycle.ts';
import {KlippySocket} from '../src/moonraker/klippy-socket.ts';
const root=process.env.MOONRAKER_SOURCE;if(!root)throw new Error('Set MOONRAKER_SOURCE');const pin=JSON.parse(await readFile(new URL('../contracts/moonraker-upstream.json',import.meta.url),'utf8')).commit;
const endpoints=['info','emergency_stop','list_endpoints','objects/query','objects/list','objects/subscribe','gcode/subscribe_output','register_remote_method'],objects=['display_status','pause_resume'],scenarios=[['startup','ready'],['ready'],['error'],['shutdown']];
const python=String.raw`
import ast,asyncio,json,logging,subprocess,sys,textwrap,types
from enum import Enum
read=lambda p:subprocess.check_output(['git','-C',sys.argv[1],'show',sys.argv[2]+':'+p],text=True)
common=ast.parse(read('moonraker/common.py'));exec('from __future__ import annotations\n'+'\n'.join(ast.unparse(n) for n in common.body if isinstance(n,ast.ClassDef) and n.name in ('ExtendedEnum','KlippyState')),globals())
owner=next(n for n in ast.parse(read('moonraker/components/klippy_connection.py')).body if isinstance(n,ast.ClassDef) and n.name=='KlippyConnection');methods=[n for n in owner.body if isinstance(n,ast.AsyncFunctionDef) and n.name in ('_check_ready','_request_endpoints','_request_initial_subscriptions','_verify_klippy_requirements')];exec('from __future__ import annotations\nclass Manager:\n'+textwrap.indent(ast.unparse(ast.Module(body=methods,type_ignores=[])),'    '),globals())
class ServerError(Exception):pass
RequestType=types.SimpleNamespace(GET=1,POST=2);RESERVED_ENDPOINTS=['list_endpoints','gcode/subscribe_output','register_remote_method'];data=json.load(sys.stdin)
async def main():
 results=[]
 for states in data['scenarios']:
  calls=[];registered=[];index=0
  class API:
   async def get_klippy_info(self,send_id):
    nonlocal index
    calls.append(['info',{'client_info':{'program':'Moonraker','version':'test'}} if send_id else {}]);value=states[min(index,len(states)-1)];index+=1;return {'state':value,'state_message':value,'software_version':'test'}
   async def list_endpoints(self,default=None):calls.append(['list_endpoints',{}]);return {'endpoints':data['endpoints']}
   async def subscribe_objects(self,objects):calls.append(['objects/subscribe',{'objects':objects,'response_template':{'method':'process_status_update'}}]);return {}
   async def subscribe_gcode_output(self):calls.append(['gcode/subscribe_output',{'response_template':{'method':'process_gcode_response'}}]);return 'ok'
   async def get_object_list(self,default=None):calls.append(['objects/list',{}]);return data['objects']
  async def event(*args):pass
  c=Manager();c._klippy_identified=False;c._klippy_started=False;c._klippy_initializing=True;c._methods_registered=False;c._missing_reqs=set();c._state=KlippyState.STARTUP;c._state.set_message('');c._klipper_version='';c._peer_cred={};c.init_attempts=0;c.klippy_reg_methods=[];c.klippy_apis=API();c._save_path_info=lambda:None;c.server=types.SimpleNamespace(send_event=event,add_log_rollover_item=lambda *args:None,register_endpoint=lambda name,*args,**kwargs:registered.append(name));c.request=lambda *args:None
  while c._klippy_initializing:await c._check_ready()
  results.append({'calls':calls,'state':str(c._state),'missing':sorted(c._missing_reqs),'endpoints':list(dict.fromkeys(registered))})
 print(json.dumps(results))
asyncio.run(main())
`;
const reference=spawnSync('/usr/bin/python3',['-c',python,root,pin],{input:JSON.stringify({scenarios,endpoints,objects}),encoding:'utf8'});if(reference.status!==0)throw new Error(reference.stderr);const expected=JSON.parse(reference.stdout);
const dir=await mkdtemp(join(tmpdir(),'klippy-init-bench-')),path=join(dir,'api.sock'),peers:Socket[]=[],captures:any[][]=[];let scenario:string[]=['ready'];
const server=createServer(socket=>{peers.push(socket);socket.on('error',()=>{});let tail='',index=0,current='startup';const calls:any[]=[];captures.push(calls);socket.on('data',chunk=>{tail+=chunk.toString();for(let end;(end=tail.indexOf('\x03'))>=0;){const m=JSON.parse(tail.slice(0,end));tail=tail.slice(end+1);calls.push([m.method,m.params]);let result:any={};if(m.method==='info'){current=scenario[Math.min(index++,scenario.length-1)];result={state:current,state_message:current,software_version:'test'};}else if(m.method==='list_endpoints')result={endpoints};else if(m.method==='objects/subscribe')result={eventtime:1,status:{webhooks:{state:current,state_message:current}}};else if(m.method==='objects/list')result={objects};else if(m.method==='bench/status')for(let i=0;i<m.params.count;i++)socket.write(JSON.stringify({method:'process_status_update',params:{eventtime:i*.1,status:{toolhead:{position:[1,2,3]},webhooks:{state:'ready',state_message:'ready'}}}})+'\x03');socket.write(JSON.stringify({id:m.id,result})+'\x03');}});});server.listen(path);await once(server,'listening');
try{
 for(let i=0;i<scenarios.length;i++){scenario=scenarios[i];const runtime=new KlippyLifecycle({version:'test',pollIntervalMs:1});try{const state=await runtime.initialize(path);assert.deepEqual({calls:captures.at(-1),state:state.state,missing:[...state.missingRequirements].sort(),endpoints:state.endpoints.filter(n=>!['list_endpoints','gcode/subscribe_output','register_remote_method'].includes(n))},expected[i]);}finally{await runtime.close();}}
 scenario=['ready'];const timings:{lifecycle:number[];direct:number[]}={lifecycle:[],direct:[]};
 for(let run=0;run<54;run++)for(const mode of run%2?['direct','lifecycle'] as const:['lifecycle','direct'] as const){const start=performance.now();for(let i=0;i<30;i++){if(mode==='lifecycle'){const runtime=new KlippyLifecycle({version:'test'});try{await runtime.initialize(path);}finally{await runtime.close();}}else{const client=new KlippySocket();try{await client.connect(path);await client.request('info',{client_info:{program:'Moonraker',version:'test'}});await client.request('list_endpoints');await client.request('objects/subscribe',{objects:{webhooks:null},response_template:{method:'process_status_update'}});await client.request('gcode/subscribe_output',{response_template:{method:'process_gcode_response'}});await client.request('list_endpoints');await client.request('objects/list');}finally{await client.close();}}}if(run>=3)timings[mode].push(performance.now()-start);}
 const callbacks:{lifecycle:number[];direct:number[]}={lifecycle:[],direct:[]};let received=0,finish:(()=>void)|undefined;const consume=(status:any)=>{assert.deepEqual(status.toolhead.position,[1,2,3]);if(++received===5000)finish?.();};const runtime=new KlippyLifecycle({version:'test',onStatus:consume}),raw=new KlippySocket();raw.registerMethod('process_status_update',p=>consume(p.status));try{await runtime.initialize(path);await raw.connect(path);for(let run=0;run<54;run++)for(const mode of run%2?['direct','lifecycle'] as const:['lifecycle','direct'] as const){received=0;const done=new Promise<void>(r=>finish=r),start=performance.now();await (mode==='lifecycle'?runtime:raw).request('bench/status',{count:5000});await done;if(run>=3)callbacks[mode].push(performance.now()-start);}}finally{await runtime.close();await raw.close();}
 const stats=(a:number[])=>{a.sort((x,y)=>x-y);return {medianMs:a[25],p95Ms:a[48],maxMs:a[50]};};console.log(JSON.stringify({node:process.version,upstream:pin,contracts:scenarios.length,samples:51,initializationsPerSample:30,lifecycle:stats(timings.lifecycle),direct:stats(timings.direct),callbacks5000:{lifecycle:stats(callbacks.lifecycle),direct:stats(callbacks.direct)},scope:'Pinned _check_ready/discovery/subscription/requirements AST for startup-ready, ready, error, shutdown with inert server events/path/service hooks. Real Unix initialization performance alternates lifecycle owner against the same six direct requests; source fixtures omit virtual_sdcard so no file-manager path handling. 5000 status callbacks include repeated webhooks state plus toolhead payload, lifecycle processing versus direct callback consumption. Not full upstream initialization or printer acceptance.'},null,2));
}finally{for(const peer of peers)peer.destroy();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
