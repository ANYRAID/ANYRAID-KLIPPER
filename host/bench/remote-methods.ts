import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createServer,type Socket} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {KlippyLifecycle} from '../src/moonraker/klippy-lifecycle.ts';
import {KlippySocket} from '../src/moonraker/klippy-socket.ts';
const root=process.env.MOONRAKER_SOURCE;if(!root)throw new Error('Set MOONRAKER_SOURCE');const pin=JSON.parse(readFileSync(new URL('../contracts/moonraker-upstream.json',import.meta.url),'utf8')).commit,names=['component.report','温度回调','a-b','__proto__','0'];
const python=String.raw`
import ast,asyncio,json,subprocess,sys,textwrap
source=subprocess.check_output(['git','-C',sys.argv[1],'show',sys.argv[2]+':moonraker/components/klippy_apis.py'],text=True)
owner=next(n for n in ast.parse(source).body if isinstance(n,ast.ClassDef) and n.name=='KlippyAPI');method=next(n for n in owner.body if isinstance(n,ast.AsyncFunctionDef) and n.name=='register_method');REG_METHOD_ENDPOINT='register_remote_method'
exec('from __future__ import annotations\nclass API:\n'+textwrap.indent(ast.unparse(method),'    '),globals())
async def main():
 calls=[];api=API()
 async def send(method,params):calls.append([method,params]);return 'ok'
 api._send_klippy_request=send
 for name in json.load(sys.stdin):await api.register_method(name)
 print(json.dumps(calls))
asyncio.run(main())
`;
const oracle=spawnSync('/usr/bin/python3',['-c',python,root,pin],{input:JSON.stringify(names),encoding:'utf8'});if(oracle.status!==0)throw new Error(oracle.stderr);const expected=JSON.parse(oracle.stdout),directory=await mkdtemp(join(tmpdir(),'remote-methods-')),path=join(directory,'api.sock'),peers:Socket[]=[],registrations:any[]=[];
const peer=createServer(socket=>{peers.push(socket);const aliases=new Map<string,string>();let tail='';socket.on('data',chunk=>{tail+=chunk.toString();let at:number;while((at=tail.indexOf('\x03'))>=0){const m=JSON.parse(tail.slice(0,at));tail=tail.slice(at+1);let result:any={};if(m.method==='info')result={state:'ready'};else if(m.method==='list_endpoints')result={endpoints:['objects/list','objects/subscribe','register_remote_method']};else if(m.method==='objects/list')result={objects:['virtual_sdcard','display_status','pause_resume']};else if(m.method==='objects/subscribe')result={status:{webhooks:{state:'ready'}},eventtime:0};else if(m.method==='register_remote_method'){registrations.push([m.method,m.params]);aliases.set(m.params.remote_method,m.params.response_template.method);}else if(m.method==='bench/callbacks')for(let i=0;i<5000;i++)socket.write(JSON.stringify({method:aliases.get('component')??'component',params:{position:i*.125,exact:'9007199254740993'}})+'\x03');socket.write(JSON.stringify({id:m.id,result})+'\x03');}});});peer.listen(path);await once(peer,'listening');
const initialization={empty:[] as number[],methods16:[] as number[]},callbacks={lifecycle:[] as number[],dynamic:[] as number[],direct:[] as number[]};
try{const contract=new KlippyLifecycle({version:'bench'});for(const name of names)contract.registerRemoteMethod(name,()=>{});await contract.initialize(path);assert.deepEqual(registrations,expected);await contract.close();
 for(let run=0;run<54;run++)for(const mode of (run%2?['empty','methods16']:['methods16','empty']) as ('empty'|'methods16')[]){const start=performance.now();for(let i=0;i<10;i++){const runtime=new KlippyLifecycle({version:'bench',remoteMethods:mode==='methods16'?Object.fromEntries(Array.from({length:16},(_,i)=>['component'+i,()=>{}])):{}});await runtime.initialize(path);await runtime.close();}if(run>=3)initialization[mode].push(performance.now()-start);}
 let count=0,finish:()=>void=()=>{};const consume=(params:any)=>{assert.equal(params.position,count*.125);assert.equal(params.exact,'9007199254740993');if(++count===5000)finish();},runtime=new KlippyLifecycle({version:'bench',remoteMethods:{component:consume}}),dynamic=new KlippyLifecycle({version:'bench'}),raw=new KlippySocket();raw.registerMethod('component',consume);await runtime.initialize(path);await dynamic.initialize(path);await dynamic.registerLiveRemoteMethod('component',consume,new AbortController().signal);await raw.connect(path);try{for(let run=0;run<54;run++)for(const mode of (run%2?['lifecycle','dynamic','direct']:['direct','dynamic','lifecycle']) as ('lifecycle'|'dynamic'|'direct')[]){count=0;const done=new Promise<void>(r=>finish=r),start=performance.now();await(mode==='lifecycle'?runtime:mode==='dynamic'?dynamic:raw).request('bench/callbacks');await done;if(run>=3)callbacks[mode].push(performance.now()-start);}}finally{await runtime.close();await dynamic.close();await raw.close();}
}finally{for(const socket of peers)socket.destroy();await new Promise<void>(r=>peer.close(()=>r()));await rm(directory,{recursive:true,force:true});}
const stats=(groups:Record<string,number[]>)=>Object.fromEntries(Object.entries(groups).map(([name,values])=>{values.sort((a,b)=>a-b);return [name,{medianMs:values[25],p95Ms:values[48]}];}));console.log(JSON.stringify({node:process.version,upstream:pin,contracts:5,samples:51,initializations:10,methods:16,callbacksPerSample:5000,initialization:stats(initialization),callbacks:stats(callbacks),scope:'Pinned register_method AST request payloads. Real Unix complete initialization with 0 versus 16 registrations, plus static and generation-scoped live component callback consumption versus raw KlippySocket dispatch. No Python callback speed or hardware acceptance claim.'},null,2));
