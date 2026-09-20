import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Socket} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {KlippyFrames,KlippySocket,type KlippySocketLimits} from '../src/moonraker/klippy-socket.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
const wire=(value:unknown)=>JSON.stringify(value)+'\x03';
const status=(code:number)=>(e:unknown)=>e instanceof ApiError&&e.status===code;
async function until(fn:()=>boolean){for(let i=0;i<500;i++){if(fn())return;await delay(2);}throw new Error('Condition timed out');}
function requests(socket:Socket,fn:(v:any,text:string)=>void){let remaining=Buffer.alloc(0);socket.on('data',chunk=>{remaining=Buffer.concat([remaining,Buffer.from(chunk)]);for(let end;(end=remaining.indexOf(3))>=0;){const text=remaining.subarray(0,end).toString();remaining=remaining.subarray(end+1);fn(JSON.parse(text),text);}});}
async function fixture(run:(client:KlippySocket,peer:Socket,path:string)=>Promise<void>,limits:KlippySocketLimits={}){const dir=await mkdtemp(join(tmpdir(),'klippy-socket-test-')),path=join(dir,'api.sock'),server=createServer(),sockets:Socket[]=[],client=new KlippySocket(limits);server.on('connection',s=>{sockets.push(s);s.on('error',()=>{});});server.listen(path);await once(server,'listening');try{const accepted=once(server,'connection');await client.connect(path);const [peer]=await accepted;await run(client,peer as Socket,path);}finally{for(const socket of sockets)socket.destroy();await client.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}}
test('ETX framing handles every byte boundary, packed frames and escaped separators',()=>{
 const expected=[{text:'中文😀\u0003'},[1,2],{x:true}],input=Buffer.from(expected.map(wire).join(''));for(let cut=0;cut<=input.length;cut++){const decoder=new KlippyFrames(),got:unknown[]=[];decoder.push(input.subarray(0,cut),b=>{got.push(JSON.parse(b.toString()));});decoder.push(input.subarray(cut),b=>{got.push(JSON.parse(b.toString()));});assert.deepEqual(got,expected);assert.equal(decoder.bufferedBytes,0);}
 const decoder=new KlippyFrames(100000);for(let i=0;i<100000;i++)decoder.push(Buffer.from('x'),()=>{});assert.equal(decoder.bufferedBytes,100000);assert.throws(()=>decoder.push(Buffer.from('y'),()=>{}),/limit/);let length=0;decoder.push(Buffer.from('\x03'),b=>{length=b.length;});assert.equal(length,100000);decoder.clear();assert.equal(decoder.bufferedBytes,0);
});
test('real Unix requests preserve wire format, numeric precision and out-of-order correlation',()=>fixture(async(client,peer)=>{
 const received:any[]=[];requests(peer,(m,text)=>{assert.equal(Object.hasOwn(m,'jsonrpc'),false);assert.match(text,/1e\+20/);received.push(m);if(received.length===2)peer.write(wire({id:received[1].id,result:{which:2}})+wire({id:received[0].id,result:{which:1}}));});const a=client.request('objects/query',{n:1e20,exact:'9007199254740993'}),b=client.request('info',{n:1e20});assert.deepEqual(await Promise.all([a,b]),[{which:1},{which:2}]);assert.equal(received[0].params.exact,'9007199254740993');assert.equal(client.status.pendingBytes,0);await until(()=>client.status.outputBytes===0);assert.equal(client.status.phase,'connected');
}));
test('pinned Klippy falsy result normalization and error messages are preserved',()=>fixture(async(client,peer)=>{
 const values=[null,false,0,'',[],{},true,[1],{x:1}];let i=0;requests(peer,m=>{if(i<values.length)peer.write(wire({id:m.id,result:values[i++]}));else if(i++===values.length)peer.write(wire({id:m.id,error:{message:'not homed'}}));else peer.write(wire({id:m.id}));});for(const value of values)assert.deepEqual(await client.request('read'),value===true||Array.isArray(value)&&value.length||typeof value==='object'&&value!==null&&!Array.isArray(value)&&Object.keys(value).length?value:'ok');await assert.rejects(client.request('fail'),e=>e instanceof ApiError&&e.status===400&&e.message==='not homed');await assert.rejects(client.request('malformed'),/Malformed Klippy Response/);
}));
test('cancel and timeout release waiting state without replay or claims that execution stopped',()=>fixture(async(client,peer)=>{
 const sent:any[]=[];requests(peer,m=>sent.push(m));const abort=new AbortController(),task=client.request('gcode/script',{script:'G1 X1'},{signal:abort.signal});await until(()=>sent.length===1);abort.abort();await assert.rejects(task,e=>e instanceof ApiError&&e.status===499&&(e.data as any).mayHaveExecuted===true);await assert.rejects(client.request('read',{}, {timeoutMs:10}),e=>e instanceof ApiError&&e.status===504&&(e.data as any).mayHaveExecuted===true);assert.equal(client.status.pending,0);peer.write(wire({id:sent[0].id,result:'late'}));await delay(2);assert.equal(client.status.phase,'connected');assert.equal(sent.length,2);const pre=new AbortController();pre.abort();assert.throws(()=>client.request('never',{}, {signal:pre.signal}),status(499));
}));
test('pending and output byte limits reject before additional writes',()=>fixture(async(client,peer)=>{
 let count=0;requests(peer,()=>count++);const first=client.request('hold'),rejected=assert.rejects(first,status(503));assert.throws(()=>client.request('second'),status(429));await until(()=>count===1);await client.close();await rejected;assert.equal(client.status.pendingBytes,0);
},{pending:1}));
test('output admission rejects a request larger than the configured output budget',()=>fixture(async(client,peer)=>{let data=false;peer.on('data',()=>data=true);assert.throws(()=>client.request('read'),status(429));await delay(2);assert.equal(data,false);assert.equal(client.status.outputBytes,0);},{outputBytes:1}));
test('remote callbacks retain ignored cancellation until their actual completion',()=>fixture(async(client,peer)=>{
 let release!:()=>void,entered=false,aborted=false;const gate=new Promise<void>(r=>release=r);client.registerMethod('process_status_update',(_p,signal)=>{entered=true;signal.addEventListener('abort',()=>aborted=true);return gate;});peer.write(wire({method:'process_status_update',params:{eventtime:1,status:{}}}));await until(()=>entered);await assert.rejects(client.close(),/shutdown deadline/);assert.equal(aborted,true);assert.equal(client.status.phase,'closing');assert.equal(client.status.callbacks,1);release();await client.close();assert.equal(client.status.callbacks,0);assert.equal(client.status.callbackBytes,0);assert.equal(client.status.phase,'closed');
},{shutdownTimeoutMs:10}));
test('callback overload faults the link instead of silently dropping status and pending requests',()=>fixture(async(client,peer)=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);client.registerMethod('status',()=>gate);const task=client.request('hold'),rejected=assert.rejects(task,status(429));peer.write(wire({method:'status',params:{n:1}})+wire({method:'status',params:{n:2}}));await rejected;assert.equal(client.status.callbacks,1);assert.equal(client.status.phase,'closing');release();await client.close();assert.equal(client.status.callbackBytes,0);
},{callbacks:1}));
test('callback timeout cancels the link but does not prematurely release ignored work',()=>fixture(async(client,peer)=>{
 let release!:()=>void,entered=false;const gate=new Promise<void>(r=>release=r);client.registerMethod('status',()=>{entered=true;return gate;});peer.write(wire({method:'status'}));await until(()=>entered);await until(()=>client.status.phase==='closing');assert.equal(client.status.callbacks,1);release();await client.close();assert.equal(client.status.phase,'closed');
},{callbackTimeoutMs:10}));
test('malformed UTF-8, unsafe integers, non-finite numbers and non-object frames fault the link',async()=>{
 for(const bad of [Buffer.from([0xff,3]),Buffer.from('{"id":1,"result":9007199254740993}\x03'),Buffer.from('{"id":1,"result":1e999}\x03'),Buffer.from('[]\x03')])await fixture(async(client,peer)=>{const task=client.request('read'),rejected=assert.rejects(task,status(502));peer.write(bad);await rejected;await client.close();assert.equal(client.status.inputBytes,0);});
});
test('oversized partial frames and peer EOF clear input and reject pending requests',async()=>{
 await fixture(async(client,peer)=>{const task=client.request('read'),rejected=assert.rejects(task,status(413));peer.write('x'.repeat(65));await rejected;await client.close();assert.equal(client.status.inputBytes,0);},{frameBytes:64});
 await fixture(async(client,peer)=>{const task=client.request('read'),rejected=assert.rejects(task,status(503));peer.end('{"partial":');await rejected;await client.close();assert.equal(client.status.pending,0);});
});
test('unknown methods are ignored, registered failures close the link and unregister respects ownership',()=>fixture(async(client,peer)=>{
 const release=client.registerMethod('status',()=>{});assert.throws(()=>client.registerMethod('status',()=>{}));release();client.registerMethod('status',()=>{throw new Error('private details');});release();peer.write(wire({method:'unknown',params:{}}));await delay(2);assert.equal(client.status.phase,'connected');const task=client.request('read'),rejected=assert.rejects(task,e=>e instanceof ApiError&&e.status===502&&!e.message.includes('private'));peer.write(wire({method:'status',params:{}}));await rejected;await client.close();
}));
test('connection failures, close before connect and repeated connects have explicit terminal states',async()=>{
 const client=new KlippySocket();assert.throws(()=>client.request('read'),status(503));await assert.rejects(client.connect('/tmp/anyraid-no-such-socket-'+process.pid),status(503));await client.close();assert.equal(client.status.phase,'closed');await assert.rejects(client.connect('/tmp/again'),status(400));const unused=new KlippySocket();await unused.close();assert.equal(unused.status.phase,'closed');await assert.rejects(unused.connect('/tmp/no'),status(400));
 await fixture(async(client,_peer,path)=>{await assert.rejects(client.connect(path),status(400));assert.equal(client.status.phase,'connected');});
});
test('close during connection establishment rejects startup and cannot later report connected',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'klippy-connect-race-')),path=join(dir,'api.sock'),server=createServer(s=>s.destroy()),client=new KlippySocket();server.listen(path);await once(server,'listening');try{const opening=client.connect(path),rejected=assert.rejects(opening,status(503));await client.close();await rejected;assert.equal(client.status.phase,'closed');assert.equal(client.signal.aborted,true);}finally{await client.close();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
test('async callback failures release ownership and expose a redacted connection fault',()=>fixture(async(client,peer)=>{
 client.registerMethod('status',()=>Promise.reject(new Error('private path')));const task=client.request('hold'),rejected=assert.rejects(task,status(502));peer.write(wire({method:'status'}));await rejected;await client.close();assert.equal(client.signal.aborted,true);assert.equal(client.signal.reason.message,'Klippy callback failed');assert.equal(client.status.callbacks,0);assert.equal(client.status.callbackBytes,0);
}));
test('closing a blocked writer releases queued output accounting and every pending request',()=>fixture(async(client,peer)=>{
 peer.pause();const waiting=Array.from({length:8},()=>assert.rejects(client.request('hold',{padding:'x'.repeat(500000)}),status(503)));assert.ok(client.status.outputBytes>0);await client.close();await Promise.all(waiting);assert.equal(client.status.outputBytes,0);assert.equal(client.status.pendingBytes,0);assert.equal(client.status.pending,0);
}));
