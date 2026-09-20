import assert from 'node:assert/strict';
import {Socket,createServer} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {unixPeerCredentials} from '../src/moonraker/unix-peer.ts';
const source=process.env.MOONRAKER_SOURCE;if(!source)throw new Error('Set MOONRAKER_SOURCE');const pin=JSON.parse(readFileSync(new URL('../contracts/moonraker-upstream.json',import.meta.url),'utf8')).commit;
const dir=await mkdtemp(join(tmpdir(),'pc-')),path=join(dir,'api.sock'),sockets:Socket[]=[],server=createServer(s=>{sockets.push(s);s.on('error',()=>{});}),client=new Socket();server.listen(path);await once(server,'listening');
try{client.connect(path);await once(client,'connect');const expected={process_id:process.pid,user_id:process.getuid!(),group_id:process.getgid!()};assert.deepEqual(unixPeerCredentials(client),expected);
 const python=String.raw`
import ast,sys,json,socket,struct,asyncio,logging,subprocess,time,types
source=subprocess.check_output(['git','-C',sys.argv[1],'show',sys.argv[2]+':moonraker/utils/__init__.py'],text=True)
method=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=='get_unix_peer_credentials')
exec('from __future__ import annotations\n'+ast.unparse(method),globals())
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.connect(sys.argv[3]);writer=types.SimpleNamespace(get_extra_info=lambda *args:s)
result=get_unix_peer_credentials(writer,'Klippy');samples=[]
for run in range(54):
 start=time.perf_counter()
 for i in range(10000):get_unix_peer_credentials(writer,'Klippy')
 if run>=3:samples.append((time.perf_counter()-start)*1000)
s.close();print(json.dumps({'credentials':result,'samples':samples,'python':sys.version.split()[0]}))
`;
 const result=spawnSync('/usr/bin/python3',['-c',python,source,pin,path],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);const oracle=JSON.parse(result.stdout);assert.deepEqual(oracle.credentials,expected);
 const samples:number[]=[];for(let run=0;run<54;run++){const start=performance.now();let last;for(let i=0;i<10000;i++)last=unixPeerCredentials(client);if(run>=3)samples.push(performance.now()-start);assert.deepEqual(last,expected);}
 const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[25],p95Ms:values[48]};};console.log(JSON.stringify({node:process.version,python:oracle.python,upstream:pin,matchingKernelCredentials:true,samples:51,readsPerSample:10000,nodeReader:stats(samples),pythonReader:stats(oracle.samples),scope:'Same real Unix server identity; extracted upstream getsockopt helper vs guarded Node-API getpeername/getsockopt. Production reads once per connection, not per motion callback. No service-provider or PID-1 attribution claim.'},null,2));
}finally{client.destroy();for(const socket of sockets)socket.destroy();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
