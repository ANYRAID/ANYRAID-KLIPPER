import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {IncomingMessage} from 'node:http';
import {Socket} from 'node:net';
import {WebSocket} from 'ws';
import {ApiKeyAuthorization,type AuthorizationOptions} from '../src/moonraker/api-key-authorization.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {EndpointRegistry,type EndpointHandler} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext,type Json} from '../src/moonraker/rpc.ts';
import {MoonrakerNetwork,type NetworkAuthorization} from '../src/moonraker/server.ts';
const issuer='http://printer.test';
const reserved=(username:string,created_on:number)=>({username,source:'moonraker',created_on});
async function fixture(options:Partial<AuthorizationOptions>={}){
 const root=await mkdtemp(join(tmpdir(),'reserved-user-')),path=join(root,'db.sqlite'),db=await DatabaseStore.open({path});
 const auth=await ApiKeyAuthorization.open(db,{issuer,...options}),rpc=new JsonRpcDispatcher(),routes=new EndpointRegistry(rpc);auth.register(routes);
 const requests:IncomingMessage[]=[];
 const request=(address='127.0.0.1',transport:'http'|'websocket'='http',url='/access/user',key?:string)=>{
  const socket=new Socket();Object.defineProperty(socket,'remoteAddress',{value:address});const request=new IncomingMessage(socket);request.method='GET';request.url=url;if(key)request.headers['x-api-key']=key;requests.push(request);
  return {request,transport,signal:new AbortController().signal} satisfies NetworkAuthorization;
 };
 const read=async(context:NetworkAuthorization)=>routes.invoke('/access/user','GET',{}, {transport:context.transport,signal:context.signal,authorize:(m,p)=>auth.authorize(m,p,context)});
 return {root,path,db,auth,rpc,routes,request,read,async close(){for(const r of requests)r.socket.destroy();await auth.close();await db.close();await rm(root,{recursive:true,force:true});}};
}
test('real HTTP and WS expose reserved or JWT public identity, consume GET bindings, and revoke rotated key sessions',async()=>{
 let now=1700000000;const f=await fixture({trustedClients:['127.0.0.1'],now:()=>now}),network=new MoonrakerNetwork(f.rpc,{endpoints:f.routes,...f.auth.networkOptions});const sockets:WebSocket[]=[];
 try{
  const address=await network.listen(),url=`http://127.0.0.1:${address.port}`,key=f.auth.localApiKey();
  const http=async(path='/access/user',headers:Record<string,string>={},body?:object)=>{const r=await fetch(url+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};};
  const trusted=reserved('_TRUSTED_USER_',now);assert.deepEqual((await http()).body.result,trusted);now++;
  assert.deepEqual((await http()).body.result,trusted);assert.deepEqual((await http('/access/user',{'x-api-key':key})).body.result,reserved('_API_KEY_USER_',1700000000));
  const alice=(await http('/access/user',{'x-api-key':key},{username:'alice',password:'pass'})).body.result;
  assert.deepEqual((await http('/access/user',{authorization:'Bearer '+alice.token})).body.result,reserved('alice',now));
  assert.equal((await http('/access/user',{authorization:'Bearer invalid'})).status,401);
  const connect=async(headers:Record<string,string>={})=>{const ws=new WebSocket(url.replace('http:','ws:')+'/websocket',{headers});sockets.push(ws);await once(ws,'open');return ws;};
  let id=0;const call=async(ws:WebSocket,method='access.get_user',params={})=>{const reply=once(ws,'message',{signal:AbortSignal.timeout(3000)});ws.send(JSON.stringify({jsonrpc:'2.0',id:++id,method,params}));return JSON.parse(String((await reply)[0]));};
  const ws=await connect();assert.deepEqual((await call(ws)).result,trusted);assert.deepEqual((await call(ws)).result,trusted);
  const batch=once(ws,'message',{signal:AbortSignal.timeout(3000)});ws.send(JSON.stringify([1,2].map(id=>({jsonrpc:'2.0',id,method:'access.get_user'}))));assert.deepEqual(JSON.parse(String((await batch)[0])).map((r:any)=>r.result),[trusted,trusted]);
  const api=await connect({'x-api-key':key}),jwt=await connect({authorization:'Bearer '+alice.token});assert.deepEqual((await call(api)).result,reserved('_API_KEY_USER_',1700000000));assert.deepEqual((await call(jwt)).result,reserved('alice',now));
  const rotated=(await http('/access/api_key',{'x-api-key':key},{})).body.result;assert.notEqual(rotated,key);assert.equal((await call(api)).error.code,-32602);assert.deepEqual((await http('/access/user',{'x-api-key':rotated})).body.result,reserved('_API_KEY_USER_',1700000000));
  assert.deepEqual((await call(ws)).result,trusted);assert.deepEqual((await call(jwt)).result,reserved('alice',now));
 }finally{for(const ws of sockets)ws.terminate();await network.close();await f.close();}
});
test('trusted descriptions slide for an IP while expired or evicted metadata does not change active WS and one-shot identity',async()=>{
 let now=1000,mono=0;const f=await fixture({trustedClients:['127.0.0.0/8'],now:()=>now,monotonicNow:()=>mono});
 try{
  const original=f.request('127.0.0.1','websocket');assert.deepEqual(await f.read(original),reserved('_TRUSTED_USER_',1000));now=4599;assert.deepEqual(await f.read(f.request()),reserved('_TRUSTED_USER_',1000));now=5000;assert.deepEqual(await f.read(f.request('127.0.0.2')),reserved('_TRUSTED_USER_',5000));
  const tokenContext=f.request(),shot=await f.routes.invoke('/access/oneshot_token','GET',{}, {transport:'http',signal:tokenContext.signal,authorize:(m,p)=>f.auth.authorize(m,p,tokenContext)}) as string;
  now=9000;assert.deepEqual(await f.read(f.request()),reserved('_TRUSTED_USER_',9000));assert.deepEqual(await f.read({...original,signal:new AbortController().signal}),reserved('_TRUSTED_USER_',1000));
  assert.deepEqual(await f.read(f.request('127.0.0.1','http','/access/user?token='+shot)),reserved('_TRUSTED_USER_',1000));
  // A spent/expired token falls through to ordinary live trusted policy, as upstream does.
  assert.deepEqual(await f.read(f.request('127.0.0.1','http','/access/user?token='+shot)),reserved('_TRUSTED_USER_',9000));
  const issue=async()=>{const c=f.request();return f.routes.invoke('/access/oneshot_token','GET',{}, {transport:'http',signal:c.signal,authorize:(m,p)=>f.auth.authorize(m,p,c)}) as Promise<string>;};
  const expires=await issue(),wrong=await issue();mono=5000;now=13000;assert.deepEqual(await f.read(f.request('127.0.0.1','http','/access/user?token='+expires)),reserved('_TRUSTED_USER_',13000));
  // An address mismatch consumes the token; an untrusted requester gains no identity.
  mono=5001;const wrongLive=await issue();assert.throws(()=>f.auth.authorize('access.get_user',{},f.request('192.0.2.1','http','/access/user?token='+wrongLive)),/Unauthorized/);now=17000;assert.deepEqual(await f.read(f.request('127.0.0.1','http','/access/user?token='+wrongLive)),reserved('_TRUSTED_USER_',17000));assert.throws(()=>f.auth.authorize('access.get_user',{},f.request('192.0.2.1','http','/access/user?token='+wrong)),/Unauthorized/);
  const beforeEviction=f.request('127.1.0.1','websocket');assert.deepEqual(await f.read(beforeEviction),reserved('_TRUSTED_USER_',17000));now=17001;
  for(let n=0;n<4097;n++)f.auth.authorize('server.info',{},f.request(`127.2.${n>>8}.${n&255}`));
  assert.deepEqual(await f.read(f.request('127.1.0.1')),reserved('_TRUSTED_USER_',17001));assert.deepEqual(await f.read({...beforeEviction,signal:new AbortController().signal}),reserved('_TRUSTED_USER_',17000));
 }finally{await f.close();}
});
test('trusted timer clears idle metadata, and live force-logins policy revokes existing WS and one-shot admission',async(t)=>{
 t.mock.timers.enable({apis:['setInterval']});let now=1000;const f=await fixture({trustedClients:['127.0.0.1'],forceLogins:true,now:()=>now});
 try{
  const ws=f.request('127.0.0.1','websocket');assert.deepEqual(await f.read(ws),reserved('_TRUSTED_USER_',1000));now=4600;t.mock.timers.tick(300000);assert.deepEqual(await f.read(f.request()),reserved('_TRUSTED_USER_',4600));assert.deepEqual(await f.read({...ws,signal:new AbortController().signal}),reserved('_TRUSTED_USER_',1000));
  const tokenContext=f.request(),shot=await f.routes.invoke('/access/oneshot_token','GET',{}, {transport:'http',signal:tokenContext.signal,authorize:(m,p)=>f.auth.authorize(m,p,tokenContext)}) as string;
  const create=f.request('127.0.0.1','http','/access/user',f.auth.localApiKey());await f.routes.invoke('/access/user','POST',{username:'alice',password:'pass'}, {transport:'http',signal:create.signal,authorize:(m,p)=>f.auth.authorize(m,p,create)});
  await assert.rejects(f.read({...ws,signal:new AbortController().signal}),/Trusted client authorization/);assert.throws(()=>f.auth.authorize('access.get_user',{},f.request('127.0.0.1','http','/access/user?token='+shot)),/Trusted client authorization/);await assert.rejects(f.read(f.request()),/Unauthorized/);
 }finally{await f.close();t.mock.timers.reset();}
});
test('GET private binding rejects changed identity, signal sharing or replay without blocking legitimate subscription association',async()=>{
 const f=await fixture({trustedClients:['127.0.0.1'],now:()=>1000});
 try{
  let handler!:EndpointHandler;const registry=new EndpointRegistry(new JsonRpcDispatcher(),(path,next)=>{if(path==='/access/user')handler=next;return next;});f.auth.register(registry);
  const a=f.request(),b=f.request('127.0.0.1','websocket');assert.doesNotThrow(()=>f.auth.networkOptions.authorizeSubscriptionConnection!({...a,signal:b.signal},b));
  const bind=()=>{const user=f.auth.authorize('access.get_user',{},a)!;return {transport:'http',signal:a.signal,user,authorize(){}} satisfies RpcContext;};
  assert.deepEqual(await handler({},'GET',bind()),reserved('_TRUSTED_USER_',1000));assert.throws(()=>handler({},'GET',{transport:'http',signal:a.signal,user:{username:'_TRUSTED_USER_'},authorize(){}}),/context changed/);
  const forged=bind();assert.throws(()=>handler({},'GET',{...forged,user:{username:'alice'}}),/identity changed/);
  bind();assert.throws(()=>f.auth.authorize('access.get_user',{}, {...b,signal:a.signal}),/context reused/);
 }finally{await f.close();}
});
test('fresh API key/time batch is atomic and old native key gains one persistent time across rotate and reopen',async()=>{
 const root=await mkdtemp(join(tmpdir(),'reserved-api-')),path=join(root,'db.sqlite');let db=await DatabaseStore.open({path}),auth:ApiKeyAuthorization|undefined;
 try{
  const batch=db.insertBatch;db.insertBatch=async()=>{throw Error('injected identity batch failure');};await assert.rejects(ApiKeyAuthorization.open(db,{issuer,now:()=>1000}),/batch failure/);db.insertBatch=batch;assert.equal(await db.namespaceContains('native_authorization','api_key'),false);assert.equal(await db.namespaceContains('native_authorization','api_key_created_on'),false);
  await db.close();db=await DatabaseStore.open({path});const key='a'.repeat(32);await db.insert('native_authorization','api_key',key);auth=await ApiKeyAuthorization.open(db,{issuer,now:()=>2000});assert.equal(auth.localApiKey(),key);assert.equal(await db.get('native_authorization','api_key_created_on'),2000);const rotated=await auth.rotate();await auth.close();auth=undefined;await db.close();db=await DatabaseStore.open({path});auth=await ApiKeyAuthorization.open(db,{issuer,now:()=>3000});assert.equal(auth.localApiKey(),rotated);assert.equal(await db.get('native_authorization','api_key_created_on'),2000);
 }finally{await auth?.close();await db.close();await rm(root,{recursive:true,force:true});}
});
test('malformed or orphaned API time and legacy receipt without declaration fail without replacing persisted identity',async()=>{
 for(const mode of ['null','text','negative','orphan','receipt','receipt-null']){
  const root=await mkdtemp(join(tmpdir(),'reserved-invalid-')),db=await DatabaseStore.open({path:join(root,'db.sqlite')});
  try{
   if(mode!=='orphan')await db.insert('native_authorization','api_key','a'.repeat(32));
   if(mode.startsWith('receipt'))await db.insertBatch('native_identity_migration',{receipt:mode==='receipt'?{schema:1}:null});else await db.insertBatch('native_authorization',{api_key_created_on:({null:null,text:'1000',negative:-1,orphan:1000} as Record<string,Json>)[mode]!});
   await assert.rejects(ApiKeyAuthorization.open(db,{issuer,now:()=>5000}),mode.startsWith('receipt')?/original startup declaration/:/identity time/);assert.equal(await db.namespaceContains('native_authorization','api_key'),mode!=='orphan');if(mode.startsWith('receipt'))assert.equal(await db.namespaceContains('native_authorization','api_key_created_on'),false);
  }finally{await db.close();await rm(root,{recursive:true,force:true});}
 }
});
