import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WebSocket,WebSocketServer} from 'ws';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {ProductClientGateway} from '../src/runtime/product-client-gateway.ts';
import {clientProxyWebSocket,clientProxyRequestHeaders,compiledClientMoonrakerConfig} from './helpers/client-proxy.ts';

test('acceptance websocket relay preserves gateway native identity and logout without granting browser cookie authority',{timeout:15000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'client-proxy-')),config=join(root,'moonraker.conf');
 const database=await DatabaseStore.open({path:join(root,'auth.db')});
 let native:ConfiguredMoonraker|undefined,gateway:ProductClientGateway|undefined;
 const sockets=new Set<WebSocket>(),wss=new WebSocketServer({noServer:true});
 let upstream='';
 const proxy=createServer((req,res)=>{const peer=request(upstream+req.url,{method:req.method,headers:clientProxyRequestHeaders(upstream,req.headers)},reply=>{res.writeHead(reply.statusCode!,reply.headers);reply.pipe(res);});peer.on('error',()=>res.destroy());req.pipe(peer);});
 proxy.on('upgrade',(req,socket,head)=>{
  const peer=clientProxyWebSocket(upstream,req.url!,req.headers);sockets.add(peer);peer.on('error',()=>socket.destroy());
  peer.once('open',()=>wss.handleUpgrade(req,socket,head,client=>{
   sockets.add(client);client.on('error',()=>peer.terminate());
   client.on('message',data=>peer.send(data,{binary:false}));peer.on('message',data=>client.send(data,{binary:false}));
   client.on('close',()=>peer.close());peer.on('close',()=>client.close());
  }));
 });
 try{
  await writeFile(config,'[server]\nhost: 127.0.0.1\nport: 0\n[authorization]\nforce_logins: true\n');
  native=await ConfiguredMoonraker.loadAuthorized(config,{database,authorization:{issuer:'http://printer.test'},information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'relay-test',missingRequirements:[]}});
  const address=await native.start();upstream='http://127.0.0.1:'+address.port;
  const created=await fetch(upstream+'/access/user',{method:'POST',headers:{'content-type':'application/json','x-api-key':native.authorization!.localApiKey()},body:JSON.stringify({username:'operator',password:'relay-test-only'})});assert.equal(created.status,200);await created.arrayBuffer();
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const relay='http://127.0.0.1:'+(proxy.address() as {port:number}).port;
  const origin='http://127.0.0.1:18420';gateway=new ProductClientGateway({origin,upstream:relay,loopbackHttp:true});
  const exposed=await gateway.listen(0),base='http://127.0.0.1:'+exposed.port;
  const http=(path:string,method='GET',body?:object,cookie?:string)=>new Promise<{status:number;cookie:string|undefined}>((resolve,reject)=>{
   const req=request(base+path,{method,headers:{host:new URL(origin).host,origin,'content-type':'application/json',...cookie?{cookie}:{}}},res=>{res.resume();res.once('end',()=>resolve({status:res.statusCode!,cookie:res.headers['set-cookie']?.[0]}));res.once('error',reject);});req.once('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  const login=await http('/_client/session','POST',{username:'operator',password:'relay-test-only'});assert.equal(login.status,200);
  const cookie=login.cookie!.split(';')[0];
  assert.equal((await http('/access/user','GET',undefined,cookie)).status,200);
  const open=async(url:string,headers:Record<string,string>)=>{const ws=new WebSocket(url,{headers});sockets.add(ws);await once(ws,'open');return ws;};
  const rpc=async(ws:WebSocket,method:string)=>{const received=once(ws,'message');ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method}));return JSON.parse(String((await received)[0]));};
  const anonymous=await open(relay.replace('http:','ws:')+'/websocket',{cookie});assert((await rpc(anonymous,'access.get_user')).error);
  const owned=await open(base.replace('http:','ws:')+'/websocket',{host:new URL(origin).host,origin,cookie});
  assert.equal((await rpc(owned,'access.get_user')).result.username,'operator');
  assert.equal((await rpc(owned,'server.info')).result.moonraker_version,'relay-test');
  const closed=once(owned,'close');const logout=await http('/_client/session','DELETE',undefined,cookie);assert.equal(logout.status,200);await closed;
  assert.equal((await http('/server/info','GET',undefined,cookie)).status,401);
 }finally{
  for(const socket of sockets)socket.terminate();await gateway?.close();await new Promise<void>(resolve=>proxy.close(()=>resolve()));wss.close();await native?.close();await database.close();await rm(root,{recursive:true,force:true});
 }
});

test('acceptance relay rejects ambiguous authority and trusted configuration still disables automatic queue dispatch',()=>{
 assert.throws(()=>clientProxyWebSocket('http://127.0.0.1:1','/websocket',{'x-api-key':['one','two']}),/Ambiguous/);
 const config=compiledClientMoonrakerConfig('[server]\nport: 0\n',true);
 assert.match(config,/trusted_clients: 127\.0\.0\.1/);assert.match(config,/load_on_startup: false/);assert.match(config,/automatic_transition: false/);assert.match(config,/job_transition_policy: operator_confirmation/);
});
