import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {JsonRpcDispatcher,ApiError,type RpcContext} from '../src/moonraker/rpc.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
const request=(id:number,params:object={})=>JSON.stringify({jsonrpc:'2.0',method:'server.identity',params,id});
const base=():RpcContext=>({transport:'websocket',signal:new AbortController().signal,authorize(){}});
test('identity is copied without credentials, frozen, and cannot leak between batch methods',async()=>{
 const rpc=new JsonRpcDispatcher(),source={username:'alice',token:'secret'},ctx=base();let calls=0;
 ctx.authorize=()=>++calls===1?source:undefined;
 rpc.register('server.identity',['websocket'],(_p,c)=>{assert.notEqual(c,ctx);if(c.user){assert.deepEqual(Object.keys(c.user),['username']);assert.ok(Object.isFrozen(c.user));source.username='changed';}return c.user?.username??null;});
 const result=JSON.parse((await rpc.dispatch('['+request(1)+','+request(2,{username:'forged',user:{username:'forged'}})+']',ctx))!);
 assert.deepEqual(result.map((v:any)=>v.result),['alice',null]);assert.equal(ctx.user,undefined);
});
test('concurrent authorizations on a shared context retain their own identity',async()=>{
 const rpc=new JsonRpcDispatcher(),ctx=base();const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
 ctx.authorize=async(_m,p)=>({username:String(p.name)});
 rpc.register('server.identity',['websocket'],async(p,c)=>{if(p.name==='alice'){entered.resolve();await gate.promise;}return c.user?.username??null;});
 const alice=rpc.dispatch(request(1,{name:'alice'}),ctx);await entered.promise;
 const bob=await rpc.dispatch(request(2,{name:'bob'}),ctx);gate.resolve();
 assert.equal(JSON.parse(bob!).result,'bob');assert.equal(JSON.parse((await alice)!).result,'alice');
});
test('invalid, denied and cancelled authorization never reaches REST or RPC handlers',async()=>{
 const rpc=new JsonRpcDispatcher(),routes=new EndpointRegistry(rpc);let entered=0;
 routes.register({endpoint:'/server/identity',methods:['POST']},()=>{entered++;return null;});
 for(const value of [{username:''},{username:'\ud800'},{username:'x\0y'},{username:'x'.repeat(4097)},[],42]){
  const ctx={...base(),authorize:()=>value as any};
  assert.equal(JSON.parse((await rpc.dispatch(request(1),ctx))!).error.code,500);
  await assert.rejects(routes.invoke('/server/identity','POST',{},ctx),/Invalid authorization identity/);
 }
 const denied={...base(),authorize(){throw new ApiError(403,'Denied');}};
 assert.equal(JSON.parse((await rpc.dispatch(request(1),denied))!).error.code,403);
 const abort=new AbortController(),cancelled={...base(),signal:abort.signal,authorize(){abort.abort();return {username:'alice'};}};
 assert.equal(JSON.parse((await rpc.dispatch(request(1),cancelled))!).error.code,500);
 assert.equal(entered,0);
});
test('real HTTP and WebSocket use only the successful authorization identity',async()=>{
 const rpc=new JsonRpcDispatcher(),routes=new EndpointRegistry(rpc);
 routes.register({endpoint:'/server/identity',methods:['POST']},(_p,_v,c)=>c.user?.username??null);
 const service=new MoonrakerNetwork(rpc,{endpoints:routes,authorize(_m,_p,c){const name=c.request.headers['x-test-identity'];if(name==='deny')throw new ApiError(403,'Denied');return typeof name==='string'?{username:name}:undefined;}});
 const addr=await service.listen(),url=`http://127.0.0.1:${addr.port}`;let ws:WebSocket|undefined;
 try{
  const post=(path:string,body:object,identity?:string)=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json',...identity?{'x-test-identity':identity}:{}},body:JSON.stringify(body)});
  assert.deepEqual(await (await post('/server/identity',{username:'forged'},'alice')).json(),{result:'alice'});
  assert.deepEqual(await (await post('/server/identity',{user:{username:'forged'}})).json(),{result:null});
  assert.equal((await post('/server/identity',{},'deny')).status,403);
  assert.equal((await (await post('/server/jsonrpc',JSON.parse(request(1)),'bob')).json() as any).result,'bob');
  ws=new WebSocket(`ws://127.0.0.1:${addr.port}/websocket`,{headers:{'x-test-identity':'carol'}});await once(ws,'open');const reply=once(ws,'message');ws.send(request(2,{username:'forged'}));assert.equal(JSON.parse(String((await reply)[0])).result,'carol');
 }finally{ws?.terminate();await service.close();}
});
