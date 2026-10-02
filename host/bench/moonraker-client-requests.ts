import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {ClientRequests,type ClientArguments} from '../src/moonraker/client-requests.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
const root=process.env.MOONRAKER_SOURCE;if(!root)throw new Error('Set MOONRAKER_SOURCE');const pin=JSON.parse(readFileSync(new URL('../contracts/moonraker-upstream.json',import.meta.url),'utf8')).commit;
const count=Number(process.env.BENCH_SAMPLES??51);if(!Number.isSafeInteger(count)||count<11||count>101)throw new Error('Invalid sample count');
const fixtures:ClientArguments[]=[null,[],{},[1,'two'],{position:[1,2,3],velocity:125.5}];
const python=String.raw`
import ast,asyncio,json,subprocess,sys,time,types,textwrap
code=subprocess.check_output(['git','-C',sys.argv[1],'show',sys.argv[2]+':moonraker/common.py'],text=True);owner=next(n for n in ast.parse(code).body if isinstance(n,ast.ClassDef) and n.name=='BaseRemoteConnection');methods=[n for n in owner.body if isinstance(n,ast.FunctionDef) and n.name in ('call_method_with_response','resolve_pending_response')]
class ServerError(Exception):pass
exec('from __future__ import annotations\nclass Connection:\n'+textwrap.indent(ast.unparse(ast.Module(body=methods,type_ignores=[])),'    '),globals())
jsonw=types.ModuleType('json_wrapper');exec(subprocess.check_output(['git','-C',sys.argv[1],'show',sys.argv[2]+':moonraker/utils/json_wrapper.py'],text=True),jsonw.__dict__)
data=json.load(sys.stdin)
async def main():
 c=Connection();c.eventloop=asyncio.get_running_loop();c.pending_responses={};captured=[]
 def send(msg):
  wire=json.loads(jsonw.dumps(msg));captured.append({**wire,'id':1});c.resolve_pending_response(wire['id'],wire.get('params'))
 c.queue_message=send
 for p in data['fixtures']:await c.call_method_with_response('agent.read',p)
 contracts=captured[:]
 def fast(msg):
  wire=json.loads(jsonw.dumps(msg));c.resolve_pending_response(wire['id'],{'position':[1,2,3],'velocity':125.5})
 c.queue_message=fast;samples=[]
 for run in range(data['samples']+3):
  start=time.perf_counter()
  for i in range(10000):await c.call_method_with_response('agent.read',{'position':[1,2,3],'velocity':125.5})
  if run>=3:samples.append((time.perf_counter()-start)*1000)
 print(json.dumps({'fixtures':contracts,'samples':sorted(samples),'python':sys.version.split()[0],'msgspec':jsonw.MSGSPEC_ENABLED}))
asyncio.run(main())
`;
const child=spawnSync('/usr/bin/python3',['-c',python,root,pin],{input:JSON.stringify({fixtures,samples:count}),encoding:'utf8'});if(child.status!==0)throw new Error(child.stderr);const reference=JSON.parse(child.stdout);
const queue=new ClientRequests(),captured:any[]=[];let capture=true;queue.add(1,{signal:new AbortController().signal,authorize(){},send(encoded){const wire=JSON.parse(encoded);if(capture)captured.push({...wire,id:1});queue.receive(1,wire.id,{result:{position:[1,2,3],velocity:125.5}});return true;}});
for(const f of fixtures)await queue.request(1,'agent.read',f);assert.deepEqual(captured,reference.fixtures);capture=false;
const samples:number[]=[];for(let run=0;run<count+3;run++){const start=performance.now();for(let i=0;i<10000;i++)await queue.request(1,'agent.read',{position:[1,2,3],velocity:125.5});if(run>=3)samples.push(performance.now()-start);}await queue.close();
const rpc=new JsonRpcDispatcher(),network=new MoonrakerNetwork(rpc,{authorize(){},authorizeClientRequest(){}});rpc.register('echo',['websocket'],p=>p);const address=await network.listen(),ws=new WebSocket(`ws://127.0.0.1:${address.port}/websocket`),inbound:number[]=[],outbound:number[]=[];let complete:((v:any)=>void)|undefined;
try{await once(ws,'open');ws.on('message',data=>{const m=JSON.parse(String(data));if(m.method)ws.send(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.params}));else complete?.(m.result);});const id=network.clients[0].id;
 for(let run=0;run<count+3;run++)for(const mode of run%2?['out','in']:['in','out']){const start=performance.now();for(let i=0;i<500;i++){const p={position:[1,2,3],velocity:125.5};if(mode==='out')await network.requestClient(id,'agent.read',p);else await new Promise<void>(resolve=>{complete=resolve;ws.send(JSON.stringify({jsonrpc:'2.0',id:i+1,method:'echo',params:p}));});}if(run>=3)(mode==='out'?outbound:inbound).push(performance.now()-start);}
}finally{ws.terminate();await network.close();}
function stats(values:number[]){values.sort((a,b)=>a-b);return {median:values[Math.floor(values.length/2)],p95:values[Math.ceil(values.length*.95)-1],max:values.at(-1)};}
console.log(JSON.stringify({node:process.version,python:reference.python,upstream:pin,fixtures:fixtures.length,samples:count,pure10000:{node:stats(samples),python:stats(reference.samples)},websocket500:{outbound:stats(outbound),inboundControl:stats(inbound)},scope:'Pure: pinned BaseRemoteConnection AST, msgspec encode and JSON decode with immediate reply. Node additionally enforces authorization, immutable snapshot, budgets, timeout, validation and cancellation. Network: same Node server, alternating direction, real sequential localhost round trips. Not Python daemon or printing deadline evidence.'},null,2));
