import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {RemoteClients} from '../src/moonraker/clients.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
import {JsonRpcDispatcher,ApiError} from '../src/moonraker/rpc.ts';
const identity=(type='web',name='client')=>({client_name:name,version:'1.0',type,url:'https://example.invalid'});
async function call(ws:WebSocket,method:string,params:unknown={},id=1){const reply=once(ws,'message');ws.send(JSON.stringify({jsonrpc:'2.0',method,params,id}));return JSON.parse(String((await reply)[0]));}
async function until(check:()=>boolean){for(let i=0;i<200;i++){if(check())return;await delay(2);}throw new Error('Condition timed out');}
test('client directory identifies all seven types and provides immutable filtered snapshots',()=>{
 const clients=new RemoteClients();let id=0;for(const type of ['web','mobile','desktop','display','bot','agent','other']){clients.add(++id);clients.identify(id,identity(type.toUpperCase(),type));}
 assert.equal(clients.all().length,7);assert.equal(clients.byType('WEB')[0].id,1);assert.equal(clients.byName('DESKTOP')[0].id,3);assert.equal(clients.agent('agent')?.id,6);assert.equal(clients.agent('AGENT'),undefined);assert.equal(clients.unidentified().length,0);assert.throws(()=>{(clients.get(1)!.identity as any).name='mutated';});assert.throws(()=>{(clients.all() as any).pop();});assert.throws(()=>clients.identify(1,identity()),/already identified/);clients.remove(6);assert.equal(clients.agent('agent'),undefined);
});
test('identity failures are transactional, bounded and never retain credentials',()=>{
 const clients=new RemoteClients();clients.add(1);for(const params of [{}, {...identity(),type:'unknown'},{...identity(),version:12},{...identity(),client_name:'x'.repeat(4097)}]){assert.throws(()=>clients.identify(1,params));assert.equal(clients.get(1)!.identity,null);}
 clients.identify(1,{...identity('agent'),api_key:'secret',access_token:'private'});assert.equal(JSON.stringify(clients.all()).includes('secret'),false);assert.equal(JSON.stringify(clients.all()).includes('private'),false);clients.add(2);assert.throws(()=>clients.identify(2,identity('agent')),/already registered/);assert.equal(clients.get(2)!.identity,null);clients.identify(2,identity('agent','other-agent'));assert.equal(clients.agent('other-agent')?.id,2);clients.remove(1);clients.add(3);clients.identify(3,identity('agent'));assert.equal(clients.agent('client')?.id,3);clients.remove(1);assert.equal(clients.agent('client')?.id,3);
});
test('live identification is WebSocket-only and still authorizes each method before mutation',async()=>{
 const rpc=new JsonRpcDispatcher();let checks=0;const network=new MoonrakerNetwork(rpc,{authorize(method,params,context){checks++;if(method==='server.connection.identify'){if(params.api_key!=='valid')throw new ApiError(401,'Unauthorized');}else if(context.request.headers['x-api-key']!=='valid')throw new ApiError(401,'Unauthorized');}});const address=await network.listen(),url=`http://127.0.0.1:${address.port}`;let ws:WebSocket|undefined;
 try{ws=new WebSocket(url.replace('http:','ws:')+'/websocket',{headers:{'x-api-key':'valid'}});await once(ws,'open');const id=(await call(ws,'server.websocket.id')).result.websocket_id;assert.equal(network.getClient(id)?.identity,null);let response=await call(ws,'server.connection.identify',{...identity(),api_key:'bad'});assert.equal(response.error.code,-32602);assert.equal(network.getClient(id)?.identity,null);
 response=await call(ws,'server.connection.identify',{...identity(),api_key:'valid'});assert.equal(response.result.connection_id,id);assert.equal(network.getClient(id)?.identity?.name,'client');assert.equal(JSON.stringify(network.clients).includes('"api_key"'),false);response=await call(ws,'server.connection.identify',{...identity(),api_key:'valid'});assert.equal(response.error.code,400);assert.equal(checks,4);
 const http=await fetch(url+'/server/jsonrpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',method:'server.connection.identify',params:identity(),id:1})});assert.equal((await http.json() as any).error.code,-32601);assert.equal(checks,4);ws.terminate();await until(()=>network.clients.length===0);assert.equal(network.getClient(id),undefined);
 }finally{ws?.terminate();await network.close();}assert.equal(rpc.has('server.connection.identify'),false);
});
test('concurrent identification commits once and disconnect during authorization cannot create a stale identity',async()=>{
 const rpc=new JsonRpcDispatcher();let release!:()=>void,entered!:()=>void;let wait=false;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);const network=new MoonrakerNetwork(rpc,{async authorize(method){if(wait&&method==='server.connection.identify'){entered();await gate;}}});const address=await network.listen(),url=`ws://127.0.0.1:${address.port}/websocket`;let ws:WebSocket|undefined,late:WebSocket|undefined;
 try{ws=new WebSocket(url);await once(ws,'open');const replies:any[]=[];ws.on('message',m=>replies.push(JSON.parse(String(m))));for(let i=0;i<2;i++)ws.send(JSON.stringify({jsonrpc:'2.0',method:'server.connection.identify',params:identity(),id:i+1}));await until(()=>replies.length===2);assert.equal(replies.filter(r=>r.result).length,1);assert.equal(replies.filter(r=>r.error?.code===400).length,1);
 wait=true;late=new WebSocket(url);await once(late,'open');late.send(JSON.stringify({jsonrpc:'2.0',method:'server.connection.identify',params:identity('agent','late'),id:3}));await started;late.terminate();await until(()=>network.clients.length===1);release();await until(()=>network.status.requests===0);assert.equal(network.getAgent('late'),undefined);
 }finally{release?.();ws?.terminate();late?.terminate();await network.close();}assert.equal(network.clients.length,0);
});
test('network validates both owned RPC names before registering either',()=>{
 const rpc=new JsonRpcDispatcher();rpc.register('server.connection.identify',['websocket'],()=>null);assert.throws(()=>new MoonrakerNetwork(rpc,{authorize(){}}),/already registered/);assert.equal(rpc.has('server.websocket.id'),false);
});
test('a disconnected agent releases its name and a fresh connection can identify with it',async()=>{
 const rpc=new JsonRpcDispatcher(),network=new MoonrakerNetwork(rpc,{authorize(){}}),address=await network.listen(),url=`ws://127.0.0.1:${address.port}/websocket`;let first:WebSocket|undefined,second:WebSocket|undefined;
 try{first=new WebSocket(url);await once(first,'open');const initial=await call(first,'server.connection.identify',identity('agent','worker'));assert.equal(network.getAgent('worker')?.id,initial.result.connection_id);first.terminate();await until(()=>network.getAgent('worker')===undefined);second=new WebSocket(url);await once(second,'open');const replacement=await call(second,'server.connection.identify',identity('agent','worker'));assert.ok(replacement.result.connection_id>initial.result.connection_id);assert.equal(network.getAgent('worker')?.id,replacement.result.connection_id);}finally{first?.terminate();second?.terminate();await network.close();}assert.equal(network.getAgent('worker'),undefined);
});
