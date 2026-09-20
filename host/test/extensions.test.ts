import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocket} from 'ws';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {JsonRpcDispatcher,ApiError,type RpcContext,type Json} from '../src/moonraker/rpc.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {registerExtensions,type ExtensionHost} from '../src/moonraker/extensions.ts';
import {RemoteClients} from '../src/moonraker/clients.ts';
const context=(id?:number):RpcContext=>({transport:'websocket',connectionId:id,signal:new AbortController().signal,authorize(){}});
const identify=(name:string,type='agent')=>({client_name:name,version:'1',type,url:''});
async function until(fn:()=>boolean){for(let i=0;i<500;i++){if(fn())return;await delay(2);}throw new Error('Condition timed out');}
class Peer{
 ws:WebSocket;events:any[]=[];calls:any[]=[];pending=new Map<number,(value:any)=>void>();next=1;
 constructor(url:string,headers:Record<string,string>={}){this.ws=new WebSocket(url,{headers});this.ws.on('message',data=>{const m=JSON.parse(String(data));if(m.method?.startsWith('notify_'))this.events.push(m);else if(m.method){this.calls.push(m);if(m.method!=='hold')this.ws.send(JSON.stringify({jsonrpc:'2.0',id:m.id,...m.method==='fail'?{error:{code:77,message:'agent failure',data:{reason:'busy'}}}:{result:m.params??null}}));}else{this.pending.get(m.id)?.(m);this.pending.delete(m.id);}});}
 call(method:string,params:unknown={}){const id=this.next++;return new Promise<any>(resolve=>{this.pending.set(id,resolve);this.ws.send(JSON.stringify({jsonrpc:'2.0',method,params,id}));});}
}
async function live(run:(service:ConfiguredMoonraker,url:string,peers:Peer[])=>Promise<void>,policy=true){const dir=await mkdtemp(join(tmpdir(),'extensions-test-')),path=join(dir,'moonraker.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');const service=await ConfiguredMoonraker.load(path,{information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize(_m,_p,c){if(c.request.headers['x-deny'])throw new ApiError(401,'Denied');},...policy?{authorizeClientRequest(method:string){if(method==='forbidden')throw new ApiError(403,'Outbound denied');},authorizeNotification(_m:string,_p:readonly Json[],c:any){if(c.request.headers['x-deny'])throw new ApiError(401,'Denied');}}:{}}),peers:Peer[]=[];try{const address=await service.start();await run(service,`http://127.0.0.1:${address.port}`,peers);}finally{for(const peer of peers)peer.ws.terminate();await service.close();await rm(dir,{recursive:true,force:true});}}
async function connect(url:string,peers:Peer[],headers:Record<string,string>={}){const peer=new Peer(url.replace('http:','ws:')+'/websocket',headers);peers.push(peer);await once(peer.ws,'open');return peer;}
test('configured extension endpoints list actual agents and forward REST and RPC arguments',()=>live(async(service,url,peers)=>{
 const agent=await connect(url,peers),web=await connect(url,peers);await agent.call('server.connection.identify',identify('worker'));await web.call('server.connection.identify',identify('browser','web'));
 const response=await fetch(url+'/server/extensions/list');assert.equal(response.status,200);assert.deepEqual(await response.json(),{result:{agents:[{name:'worker',version:'1',type:'agent',url:''}]}});
 for(const args of [null,[],{},[1,'x'],{position:[1,2,3]}]){const result=await web.call('server.extensions.request',{agent:'worker',method:'echo',arguments:args});assert.deepEqual(result.result,args&&Object.keys(args).length?args:null);}
 const post=await fetch(url+'/server/extensions/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agent:'worker',method:'echo',arguments:{n:1}})});assert.deepEqual(await post.json(),{result:{n:1}});assert.equal((await fetch(url+'/server/extensions/request')).status,405);
 agent.ws.terminate();await until(()=>!service.getAgent('worker'));assert.deepEqual((await web.call('server.extensions.list')).result,{agents:[]});assert.equal((await web.call('server.extensions.request',{agent:'worker',method:'echo'})).error.code,400);
}));
test('extension requests enforce both authorization policies and preserve remote RPC errors',()=>live(async(_service,url,peers)=>{
 const agent=await connect(url,peers),caller=await connect(url,peers),denied=await connect(url,peers,{'x-deny':'yes'});await agent.call('server.connection.identify',identify('worker'));
 assert.equal((await denied.call('server.extensions.request',{agent:'worker',method:'echo'})).error.code,-32602);assert.equal((await fetch(url+'/server/extensions/list',{headers:{'x-deny':'yes'}})).status,401);assert.equal(agent.calls.length,0);
 assert.equal((await caller.call('server.extensions.request',{agent:'worker',method:'forbidden'})).error.code,403);assert.equal(agent.calls.length,0);
 const failed=await caller.call('server.extensions.request',{agent:'worker',method:'fail'});assert.equal(failed.error.code,424);assert.deepEqual(failed.error.data,{code:77,message:'agent failure',data:{reason:'busy'}});
 for(const p of [{agent:'worker',method:'echo',arguments:3},{agent:'worker',method:''},{agent:3,method:'echo'},{agent:'worker',method:true}])assert.equal((await caller.call('server.extensions.request',p)).error.code,400);
}));
test('custom events use live agent identity, exclude sender and filter unauthorized recipients',()=>live(async(_service,url,peers)=>{
 const agent=await connect(url,peers),observer=await connect(url,peers),denied=await connect(url,peers,{'x-deny':'yes'});await agent.call('server.connection.identify',identify('worker'));await until(()=>observer.events.length===1);observer.events.length=0;
 assert.equal((await observer.call('server.connection.send_event',{event:'progress'})).error.code,400);
 for(const event of ['connected','disconnected'])assert.equal((await agent.call('server.connection.send_event',{event})).error.code,400);
 assert.equal((await agent.call('server.connection.send_event',{event:'progress',data:{percent:50},agent:'forged'})).result,'ok');await until(()=>observer.events.length===1);assert.deepEqual(observer.events[0],{jsonrpc:'2.0',method:'notify_agent_event',params:[{agent:'worker',event:'progress',data:{percent:50}}]});assert.equal(agent.events.length,0);assert.equal(denied.events.length,0);
 const result:any=await(await fetch(url+'/server/jsonrpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:9,method:'server.connection.send_event',params:{event:'progress'}})})).json();assert.equal(result.error.code,-32601);assert.equal((await fetch(url+'/server/connection/send_event',{method:'POST'})).status,404);
}));
test('disconnected caller cancels its forwarded request without disconnecting the agent',()=>live(async(service,url,peers)=>{
 const agent=await connect(url,peers);await agent.call('server.connection.identify',identify('worker'));const abort=new AbortController(),pending=fetch(url+'/server/extensions/request',{method:'POST',headers:{'content-type':'application/json'},signal:abort.signal,body:JSON.stringify({agent:'worker',method:'hold'})}).catch(()=>null);await until(()=>agent.calls.length===1);assert.equal(service.status.clientRequests?.awaiting,1);abort.abort();await pending;await until(()=>service.status.clientRequests?.pending===0);assert.equal(agent.ws.readyState,WebSocket.OPEN);agent.ws.send(JSON.stringify({jsonrpc:'2.0',id:agent.calls[0].id,result:'late'}));assert.equal((await agent.call('server.extensions.request',{agent:'worker',method:'echo',arguments:{ok:true}})).result.ok,true);
}));
test('agent disconnect rejects callers and a replacement cannot complete old requests',()=>live(async(service,url,peers)=>{
 const agent=await connect(url,peers),caller=await connect(url,peers);await agent.call('server.connection.identify',identify('worker'));const task=caller.call('server.extensions.request',{agent:'worker',method:'hold'});await until(()=>agent.calls.length===1);agent.ws.terminate();assert.equal((await task).error.code,503);await until(()=>!service.getAgent('worker'));const replacement=await connect(url,peers);await replacement.call('server.connection.identify',identify('worker'));assert.deepEqual((await caller.call('server.extensions.request',{agent:'worker',method:'echo',arguments:[1]})).result,[1]);
}));
test('missing notification and request policies fail closed through extension endpoints',()=>live(async(_service,url,peers)=>{
 const agent=await connect(url,peers);await agent.call('server.connection.identify',identify('worker'));assert.equal((await agent.call('server.extensions.request',{agent:'worker',method:'echo'})).error.code,503);assert.equal((await agent.call('server.connection.send_event',{event:'progress'})).error.code,503);assert.equal(agent.calls.length,0);
},false));
test('extension registration rollback preserves existing owners and releases routes idempotently',async()=>{
 const rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc),clients=new RemoteClients(),host:ExtensionHost={getClient:id=>clients.get(id),getAgent:name=>clients.agent(name),getAgents:()=>clients.agents(),requestClient:async()=>null,broadcast:async()=>{}};
 const existing=registry.register({endpoint:'/server/extensions/request',methods:['POST']},()=> 'existing');assert.throws(()=>registerExtensions(registry,host));assert.equal(rpc.has('server.extensions.list'),false);assert.equal(registry.allowed('/server/extensions/list'),undefined);assert.equal(JSON.parse((await rpc.dispatch('{"jsonrpc":"2.0","method":"server.extensions.request","id":1}',context()))!).result,'existing');existing();const release=registerExtensions(registry,host);assert.equal(rpc.has('server.connection.send_event'),true);release();release();assert.equal(rpc.has('server.extensions.request'),false);assert.equal(rpc.has('server.connection.send_event'),false);
});
test('agent list follows identification order and releases identities on removal',async()=>{
 const clients=new RemoteClients();for(const id of [1,2,3])clients.add(id);clients.identify(3,identify('third'));clients.identify(1,identify('first'));clients.identify(2,identify('browser','web'));assert.deepEqual(clients.agents().map(c=>c.id),[3,1]);clients.remove(3);clients.add(4);clients.identify(4,identify('third'));assert.deepEqual(clients.agents().map(c=>c.id),[1,4]);assert.ok(Object.isFrozen(clients.agents()));
});
