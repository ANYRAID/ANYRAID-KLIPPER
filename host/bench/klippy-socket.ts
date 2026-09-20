import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer,type Socket} from 'node:net';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {KlippySocket} from '../src/moonraker/klippy-socket.ts';
import type {Json} from '../src/moonraker/rpc.ts';
const values:Json[]=[null,false,0,'',[],{},[1],{x:1},true];
if(process.argv[2]==='--client'){
 const client=new KlippySocket(),input=createInterface({input:process.stdin});let received=0,expected=0,complete:(()=>void)|undefined;client.registerMethod('status',p=>{assert.deepEqual(p.position,[1,2,3]);if(++received===expected)complete?.();});try{await client.connect(process.argv[3]);const fixtures=[];for(const value of values)fixtures.push(await client.request('fixture',{value}));try{await client.request('fail');}catch(e){fixtures.push({error:(e as any).status,message:(e as Error).message});}console.log(JSON.stringify({fixtures,node:process.version}));
 for await(const line of input){const {count,concurrency,quit,callbacks}=JSON.parse(line);if(quit)break;const start=performance.now();if(callbacks){received=0;expected=count;const done=new Promise<void>(r=>complete=r);await client.request('bench/status',{count});await done;console.log(JSON.stringify({ms:performance.now()-start}));continue;}let next=0;await Promise.all(Array.from({length:concurrency},async()=>{for(;;){const i=next++;if(i>=count)break;assert.deepEqual(await client.request('objects/query',{position:[1,2,3],velocity:125.5}),{position:[1,2,3],velocity:125.5});}}));console.log(JSON.stringify({ms:performance.now()-start}));}
 }finally{input.close();process.stdin.destroy();await client.close();}
}else{
 const root=process.env.MOONRAKER_SOURCE;if(!root)throw new Error('Set MOONRAKER_SOURCE');const pin=JSON.parse(await readFile(new URL('../contracts/moonraker-upstream.json',import.meta.url),'utf8')).commit,samples=Number(process.env.BENCH_SAMPLES??51);if(!Number.isSafeInteger(samples)||samples<11||samples>101)throw new Error('Invalid sample count');
 const python=String.raw`
import asyncio,ast,contextlib,json,logging,subprocess,sys,textwrap,time,types
source=subprocess.check_output(['git','-C',sys.argv[1],'show',sys.argv[2]+':moonraker/components/klippy_connection.py'],text=True);module=ast.parse(source);owner=next(n for n in module.body if isinstance(n,ast.ClassDef) and n.name=='KlippyConnection');request=next(n for n in module.body if isinstance(n,ast.ClassDef) and n.name=='KlippyRequest');methods=[n for n in owner.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in ('_process_command','_write_request','_request_standard','_execute_method')]
class ServerError(Exception):
 def __init__(self,message,status=400):self.status=status;super().__init__(message)
exec('from __future__ import annotations\n'+ast.unparse(request)+'\nclass Connection:\n'+textwrap.indent(ast.unparse(ast.Module(body=methods,type_ignores=[])),'    '),globals())
jsonw=types.ModuleType('json_wrapper');exec(subprocess.check_output(['git','-C',sys.argv[1],'show',sys.argv[2]+':moonraker/utils/json_wrapper.py'],text=True),jsonw.__dict__)
class Request:
 def __init__(self,method,params):self.method=method;self.params=params
 def get_endpoint(self):return self.method
 def get_args(self):return self.params
async def main():
 reader,writer=await asyncio.open_unix_connection(sys.argv[3],limit=20*1024*1024);c=Connection();c.writer=writer;c.closing=False;c.pending_requests={};c.remote_methods={};c.event_loop=types.SimpleNamespace(register_callback=lambda fn,*args,**kwargs:asyncio.create_task(fn(*args,**kwargs)))
 received=0;expected=0;ready=asyncio.Event()
 def status(**params):
  nonlocal received
  assert params['position']==[1,2,3];received+=1
  if received==expected:ready.set()
 c.remote_methods['status']=status
 async def read():
  while True:c._process_command(jsonw.loads((await reader.readuntil(b'\x03'))[:-1]))
 reading=asyncio.create_task(read());fixtures=[]
 try:
  for value in [None,False,0,'',[],{},[1],{'x':1},True]:fixtures.append(await c._request_standard(Request('fixture',{'value':value})))
  try:await c._request_standard(Request('fail',{}))
  except ServerError as e:fixtures.append({'error':e.status,'message':str(e)})
  print(json.dumps({'fixtures':fixtures,'python':sys.version.split()[0],'msgspec':jsonw.MSGSPEC_ENABLED}),flush=True)
  while True:
   line=await asyncio.to_thread(sys.stdin.readline)
   if not line:break
   command=json.loads(line)
   if command.get('quit'):break
   start=time.perf_counter();next_id=0
   if command.get('callbacks'):
    received=0;expected=command['count'];ready.clear();await c._request_standard(Request('bench/status',{'count':expected}));await ready.wait();print(json.dumps({'ms':(time.perf_counter()-start)*1000}),flush=True);continue
   async def worker():
    nonlocal next_id
    while next_id<command['count']:
     next_id+=1;params={'position':[1,2,3],'velocity':125.5};assert await c._request_standard(Request('objects/query',params))==params
   await asyncio.gather(*(worker() for _ in range(command['concurrency'])))
   print(json.dumps({'ms':(time.perf_counter()-start)*1000}),flush=True)
 finally:
  c.closing=True;reading.cancel()
  with contextlib.suppress(asyncio.CancelledError):await reading
  writer.close();await writer.wait_closed()
asyncio.run(main())
`;
 const dir=await mkdtemp(join(tmpdir(),'klippy-socket-bench-')),path=join(dir,'api.sock'),peers:Socket[]=[],server=createServer(socket=>{peers.push(socket);let tail=Buffer.alloc(0);socket.on('error',()=>{});socket.on('data',chunk=>{tail=Buffer.concat([tail,Buffer.from(chunk)]);for(let at;(at=tail.indexOf(3))>=0;){const m=JSON.parse(tail.subarray(0,at).toString());tail=tail.subarray(at+1);if(m.method==='bench/status')for(let i=0;i<m.params.count;i++)socket.write(JSON.stringify({method:'status',params:{position:[1,2,3],eventtime:i*.1}})+'\x03');socket.write(JSON.stringify({id:m.id,...m.method==='fail'?{error:{message:'not homed'}}:{result:m.method==='fixture'?m.params.value:m.method==='bench/status'?'ok':m.params}})+'\x03');}});});server.listen(path);await once(server,'listening');
 const launch=(cmd:string,args:string[])=>{const child=spawn(cmd,args,{stdio:['pipe','pipe','pipe']}),lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();let stderr='';child.stderr.on('data',d=>stderr+=String(d));const exit=once(child,'exit');return {child,exit,async read(){const next=await lines.next();if(next.done)throw new Error(stderr||'Client exited');return JSON.parse(next.value);},async run(count:number,concurrency:number,callbacks=false){child.stdin.write(JSON.stringify({count,concurrency,callbacks})+'\n');return this.read();}};};
 const clients={node:launch(process.execPath,[fileURLToPath(import.meta.url),'--client',path]),python:launch('/usr/bin/python3',['-c',python,root,pin,path])},timings={node:{serial:[] as number[],concurrent:[] as number[],callbacks:[] as number[]},python:{serial:[] as number[],concurrent:[] as number[],callbacks:[] as number[]}};
 try{const node=await clients.node.read(),py=await clients.python.read();assert.deepEqual(node.fixtures,py.fixtures);for(let run=0;run<samples+3;run++)for(const mode of ['serial','concurrent','callbacks'] as const)for(const runtime of run%2?['python','node'] as const:['node','python'] as const){const result=await clients[runtime].run(mode==='serial'?500:mode==='callbacks'?5000:512,mode==='serial'?1:16,mode==='callbacks');if(run>=3)timings[runtime][mode].push(result.ms);}
 const stat=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[Math.floor(v.length/2)],p95Ms:v[Math.ceil(v.length*.95)-1],maxMs:v.at(-1)};};console.log(JSON.stringify({node:node.node,python:py.python,msgspec:py.msgspec,upstream:pin,fixtures:node.fixtures.length,samples,nodeResults:{serial:stat(timings.node.serial),concurrent:stat(timings.node.concurrent),callbacks:stat(timings.node.callbacks)},pythonResults:{serial:stat(timings.python.serial),concurrent:stat(timings.python.concurrent),callbacks:stat(timings.python.callbacks)},scope:'Separate Node and Python client processes alternate against the same Unix echo peer. Python uses pinned KlippyRequest and _request_standard/_write_request/_process_command AST and msgspec. 500 sequential / 512 requests at 16 concurrency; 5000 remote callbacks per sample are fully consumed through registered handlers; contracts include falsy results and remote error. No actual printer, Klippy readiness/subscriptions or motion deadline proof.'},null,2));
 }finally{for(const c of Object.values(clients)){c.child.stdin.end('{"quit":true}\n');await c.exit;}for(const peer of peers)peer.destroy();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
}
