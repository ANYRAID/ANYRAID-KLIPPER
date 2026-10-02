import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Socket,createServer} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {unixPeerCredentials} from '../src/moonraker/unix-peer.ts';
const native=createRequire(import.meta.url)(process.env.ANYRAID_UNIX_PEER_ADDON??'../build/unix-peer.node') as {credentials(fd:unknown):unknown};
test('kernel peer credentials identify the server process rather than the inspecting Node process',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'peer-')),path=join(dir,'api.sock'),child=spawn(process.execPath,['--input-type=module','-e',"import {createServer} from 'node:net';const server=createServer(s=>s.on('error',()=>{}));server.listen(process.argv[1],()=>process.stdout.write('ready'));",path],{stdio:['ignore','pipe','pipe']}),socket=new Socket();
 try{await once(child.stdout!,'data');socket.connect(path);await once(socket,'connect');const credentials=unixPeerCredentials(socket);assert.deepEqual(credentials,{process_id:child.pid,user_id:process.getuid!(),group_id:process.getgid!()});assert.notEqual(credentials.process_id,process.pid);assert.ok(Object.isFrozen(credentials));socket.destroy();assert.throws(()=>unixPeerCredentials(socket),/connected/);
 }finally{socket.destroy();const exited=once(child,'exit');child.kill();await exited;await rm(dir,{recursive:true,force:true});}
});
test('native reader rejects invalid, non-socket, closed and TCP descriptors without taking ownership',async()=>{
 for(const fd of [-1,1.5,NaN,Infinity,2147483648,'3',null])assert.throws(()=>native.credentials(fd),/descriptor/);
 const fd=openSync('/dev/null','r');try{assert.throws(()=>native.credentials(fd),/peer address/);}finally{closeSync(fd);}assert.throws(()=>native.credentials(fd),/peer address/);
 const server=createServer(),socket=new Socket();let accepted:Socket|undefined;server.on('connection',s=>accepted=s);server.listen(0,'127.0.0.1');await once(server,'listening');try{socket.connect((server.address() as any).port,'127.0.0.1');await once(socket,'connect');assert.throws(()=>unixPeerCredentials(socket),/Unix socket/);assert.equal(socket.destroyed,false);}finally{socket.destroy();accepted?.destroy();await new Promise<void>(r=>server.close(()=>r()));}
 assert.throws(()=>unixPeerCredentials(new Socket()),/connected/);
});
