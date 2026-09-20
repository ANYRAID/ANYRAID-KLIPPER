import {once} from 'node:events';
import {WebSocket} from 'ws';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {NotificationFanout} from '../src/moonraker/notifications.ts';
const root=process.env.MOONRAKER_SOURCE;if(!root)throw new Error('Set MOONRAKER_SOURCE');const pin=JSON.parse(readFileSync(new URL('../contracts/moonraker-upstream.json',import.meta.url),'utf8')).commit;
const sampleCount=Number(process.env.BENCH_SAMPLES??11);if(!Number.isSafeInteger(sampleCount)||sampleCount<11||sampleCount>101)throw new Error('BENCH_SAMPLES must be between 11 and 101');
const fixtures=[{name:'klippy_ready',data:[],mask:[]},{name:'klippy_shutdown',data:[],mask:[]},{name:'klippy_disconnected',data:[],mask:[]},{name:'gcode_response',data:['温度: 200.125\n// ready'],mask:[]},{name:'gcode_response',data:[''],mask:[]},{name:'state',data:[],mask:[]},{name:'status_update',data:[{toolhead:{position:[1,2,3],velocity:125.5}},100.25],mask:[1]},{name:'agent_event',data:[{agent:'worker',event:'connected',data:{name:'worker',version:'1',type:'agent',url:''}}],mask:[3]},{name:'agent_event',data:[{agent:'worker',event:'disconnected'}],mask:[]}];
const python=String.raw`
import ast,sys,json,subprocess,types,time,textwrap
code=subprocess.check_output(['git','-C',sys.argv[1],'show',sys.argv[2]+':moonraker/components/websockets.py'],text=True);owner=next(n for n in ast.parse(code).body if isinstance(n,ast.ClassDef) and n.name=='WebsocketManager');method=next(n for n in owner.body if isinstance(n,ast.FunctionDef) and n.name=='notify_clients');exec('from __future__ import annotations\nclass Manager:\n'+textwrap.indent(ast.unparse(method),'    '),globals())
jsonw=types.ModuleType('json_wrapper');exec(subprocess.check_output(['git','-C',sys.argv[1],'show',sys.argv[2]+':moonraker/utils/json_wrapper.py'],text=True),jsonw.__dict__)
class Client:
 def __init__(self,uid,denied=False,capture=False):self.uid=uid;self.need_auth=denied;self.capture=capture;self.messages=[];self.bytes=0
 def queue_message(self,msg):
  encoded=jsonw.dumps(msg);self.bytes+=len(encoded)
  if self.capture:self.messages.append(json.loads(encoded))
data=json.load(sys.stdin);m=Manager();results=[]
for f in data['fixtures']:
 m.clients={i:Client(i,i==2,True) for i in range(1,5)};m.notify_clients(f['name'],f['data'],f['mask']);results.append([c.messages for c in m.clients.values()])
m.clients={i:Client(i) for i in range(1,21)};samples=[];payload=[{'toolhead':{'position':[1,2,3],'velocity':125.5}},100.25]
for run in range(data['samples']+3):
 start=time.perf_counter()
 for i in range(1000):m.notify_clients('status_update',payload)
 if run>=3:samples.append((time.perf_counter()-start)*1000)
print(json.dumps({'fixtures':results,'samples':sorted(samples),'python':sys.version.split()[0],'msgspec':jsonw.MSGSPEC_ENABLED}))
`;
const reference=spawnSync(process.env.PYTHON??'/usr/bin/python3',['-c',python,root,pin],{input:JSON.stringify({fixtures,samples:sampleCount}),encoding:'utf8',maxBuffer:4*1024*1024});if(reference.status!==0)throw new Error(reference.stderr);const result=JSON.parse(reference.stdout);
for(let n=0;n<fixtures.length;n++){const f=fixtures[n],queue=new NotificationFanout(),messages:any[][]=[[],[],[],[]];for(let i=1;i<=4;i++)queue.add(i,{signal:new AbortController().signal,authorize(){if(i===2)throw new Error('Denied');},send:text=>{messages[i-1].push(JSON.parse(text));return true;},disconnect(){}});await queue.publish('notify_'+f.name,f.data,f.mask);assert.deepEqual(messages,result.fixtures[n]);await queue.close();}
const queue=new NotificationFanout();let bytes=0;for(let i=1;i<=20;i++)queue.add(i,{signal:new AbortController().signal,authorize(){},send:message=>{bytes+=message.length;return true;},disconnect(){}});const samples:number[]=[];for(let run=0;run<sampleCount+3;run++){const start=performance.now();for(let i=0;i<1000;i++){const delivery=await queue.publish('notify_status_update',[{toolhead:{position:[1,2,3],velocity:125.5}},100.25]);assert.equal(delivery.sent,20);}if(run>=3)samples.push(performance.now()-start);}await queue.close();samples.sort((a,b)=>a-b);
const network=new MoonrakerNetwork(new JsonRpcDispatcher(),{authorize(){},authorizeNotification(){}}),address=await network.listen(),sockets:WebSocket[]=[],wire:{manual:number[];broadcast:number[]}={manual:[],broadcast:[]};
let counts:number[]=[],complete:(()=>void)|undefined;
try{
 for(let i=0;i<20;i++){const socket=new WebSocket('ws://127.0.0.1:'+address.port+'/websocket');sockets.push(socket);await once(socket,'open');socket.on('message',message=>{assert.equal(JSON.parse(String(message)).method,'notify_status_update');counts[i]++;if(counts.every(n=>n===200))complete?.();});}
 const ids=network.clients.map(c=>c.id),payload=[{toolhead:{position:[1,2,3],velocity:125.5}},100.25];
 for(let run=0;run<sampleCount+3;run++)for(const mode of (run%2?['broadcast','manual']:['manual','broadcast']) as ('manual'|'broadcast')[]){
  counts=Array(20).fill(0);let timer:ReturnType<typeof setTimeout>;const received=new Promise<void>((resolve,reject)=>{complete=resolve;timer=setTimeout(()=>reject(new Error('Notification receive timeout')),5000);});const start=performance.now();
  try{for(let i=0;i<200;i++){if(mode==='broadcast')assert.equal((await network.broadcast('notify_status_update',payload)).sent,20);else{for(const id of ids)assert.equal(network.notify(id,'notify_status_update',payload),true);await Promise.resolve();}}await received;if(run>=3)wire[mode].push(performance.now()-start);}finally{clearTimeout(timer!);complete=undefined;}
 }
}finally{for(const socket of sockets)socket.terminate();await network.close();}
for(const times of Object.values(wire))times.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,python:result.python,msgspec:result.msgspec,upstream:pin,samples:sampleCount,fixtures:fixtures.length,publications:1000,recipients:20,deliveries:20000,nodeMedianMs:samples[Math.floor((sampleCount-1)/2)],nodeP95Ms:samples[Math.ceil(sampleCount*.95)-1],pythonMedianMs:result.samples[Math.floor((sampleCount-1)/2)],pythonP95Ms:result.samples[Math.ceil(sampleCount*.95)-1],bytes,wireDeliveries:4000,wireRecipients:20,manualWireMedianMs:wire.manual[Math.floor((sampleCount-1)/2)],manualWireP95Ms:wire.manual[Math.ceil(sampleCount*.95)-1],broadcastWireMedianMs:wire.broadcast[Math.floor((sampleCount-1)/2)],broadcastWireP95Ms:wire.broadcast[Math.ceil(sampleCount*.95)-1],scope:'Pinned notify_clients, original JSON wrapper; queue_message serializes per recipient then consumes without socket I/O. Node uses synchronous permission callback, frozen payload, capacity accounting and one encoding per publication. Wire comparison: existing direct recipient loop versus authorized broadcast, 20 real localhost WebSockets, alternating order and waiting for every receipt. Async authorization and hardware printing are separate gates.'},null,2));
