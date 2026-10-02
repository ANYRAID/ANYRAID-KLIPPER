import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {JsonRpcDispatcher,ApiError,type RpcContext} from '../src/moonraker/rpc.ts';
import {EndpointRegistry,parseRestArguments} from '../src/moonraker/endpoints.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
const context=():RpcContext=>({transport:'websocket',signal:new AbortController().signal,authorize(){}});
const dispatch=(rpc:JsonRpcDispatcher,method:string)=>rpc.dispatch(JSON.stringify({jsonrpc:'2.0',method,id:1}),context()).then(r=>JSON.parse(r!));
test('endpoint mapping shares verbs across REST and RPC with atomic duplicate checks',async()=>{
 const rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc),remove=registry.register({endpoint:'/server/item',methods:['DELETE','GET','POST']},(_p,verb)=>verb);
 assert.throws(()=>registry.register({endpoint:'/server/jsonrpc',methods:['POST']},()=>null),/Invalid/);
 assert.deepEqual(registry.allowed('/server/item'),['GET','POST','DELETE']);for(const verb of ['get','post','delete'])assert.equal((await dispatch(rpc,`server.${verb}_item`)).result,verb.toUpperCase());
 assert.throws(()=>registry.register({endpoint:'/server/get_item',methods:['GET']},()=>null),/already/);assert.equal(registry.allowed('/server/get_item'),undefined);remove();registry.register({endpoint:'/server/item',methods:['GET']},()=>2);remove();assert.equal((await dispatch(rpc,'server.item')).result,2);
});
test('HTTP-only and remote endpoints retain their transport and naming rules',async()=>{
 const rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc);registry.register({endpoint:'/server/local',methods:['GET'],transports:['http']},()=>true);assert.equal(rpc.has('server.local'),false);registry.register({endpoint:'objects/query',methods:['GET'],remote:true},p=>p);assert.deepEqual(registry.allowed('/printer/objects/query'),['GET','POST']);assert.equal(rpc.has('printer.objects.query'),true);assert.deepEqual(JSON.parse(JSON.stringify(registry.parse('/printer/objects/query','toolhead=position,velocity&extruder=&token=secret',Buffer.alloc(0),''))),{objects:{toolhead:['position','velocity'],extruder:null}});
});
test('REST parsing uses the final duplicate value, type hints, exclusions, form fields and JSON precedence',()=>{
 const query='x=old&x=last&n:int=1_200&f:float=1.25e-3&enabled:bool=TRUE&off:bool=1&data:json=%7B%22x%22%3A1%7D&bad:int=no&_:int=2&_=stamp&token=hidden&access_token=hidden&connection_id=123';
 const actual=parseRestArguments(query,Buffer.from('x=form&more=1'), 'application/x-www-form-urlencoded');assert.equal(actual.x,'form');assert.equal(actual.n,1200);assert.equal(actual.f,.00125);assert.equal(actual.enabled,true);assert.equal(actual.off,false);assert.deepEqual(actual.data,{x:1});assert.equal(actual.bad,'no');assert.equal(actual._,2);assert.equal(Object.hasOwn(actual,'token'),false);const json=parseRestArguments('x=query',Buffer.from('{"x":5,"__proto__":{"polluted":true}}'),'application/json');assert.equal(json.x,5);assert.equal(Object.getPrototypeOf(json),null);assert.equal(({} as any).polluted,undefined);assert.deepEqual(parseRestArguments('x=1',Buffer.from('{'),'application/json'),Object.assign(Object.create(null),{x:'1'}));
});
test('REST rejects malformed encodings and non-object JSON while preserving unrepresentable numeric hints as strings',()=>{
 assert.throws(()=>parseRestArguments('bad=%ff',Buffer.alloc(0),''),/Parsing/);assert.throws(()=>parseRestArguments('',Buffer.from('[1,2]'),'application/json'),/object/);const values=parseRestArguments('n:int=9007199254740993&f:float=Infinity',Buffer.alloc(0),'');assert.equal(values.n,'9007199254740993');assert.equal(values.f,'Infinity');
});
test('REST invocation authorizes the canonical method, checks cancellation and validates JSON results',async()=>{
 const rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc);let calls=0;registry.register({endpoint:'/machine/action',methods:['POST','DELETE']},()=>{calls++;return NaN;});let name='';const c={...context(),transport:'http' as const,authorize(n:string){name=n;throw new ApiError(401,'Unauthorized');}};await assert.rejects(registry.invoke('/machine/action','POST',{},c),/Unauthorized/);assert.equal(name,'machine.post_action');assert.equal(calls,0);await assert.rejects(registry.invoke('/machine/action','GET',{},context()),/Allowed/);await assert.rejects(registry.invoke('/machine/action','POST',{},context()),/Non-JSON/);assert.equal(calls,1);
});
test('network REST endpoints share business handlers and authorization with websocket RPC',async()=>{
 const rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc),seen:string[]=[];registry.register({endpoint:'/server/example',methods:['GET','POST']},(p,verb)=>({verb,...p}));registry.register({endpoint:'/server/fail',methods:['POST']},()=>{throw new ApiError(409,'Conflict');});const service=new MoonrakerNetwork(rpc,{endpoints:registry,authorize(method,_p,c){seen.push(method);if(c.request.headers['x-api-key']!=='key')throw new ApiError(401,'Unauthorized');}}),address=await service.listen(),url=`http://127.0.0.1:${address.port}`;let ws:WebSocket|undefined;
 try{let r=await fetch(url+'/server/example?v:int=3',{headers:{'X-Api-Key':'key'}});assert.deepEqual(await r.json(),{result:{verb:'GET',v:3}});r=await fetch(url+'/server/example',{method:'POST',headers:{'X-Api-Key':'key','content-type':'application/json'},body:'{"v":4}'});assert.deepEqual(await r.json(),{result:{verb:'POST',v:4}});r=await fetch(url+'/server/example');assert.equal(r.status,401);r=await fetch(url+'/server/fail',{method:'POST',headers:{'X-Api-Key':'key'}});assert.equal(r.status,409);assert.deepEqual(await r.json(),{error:{code:409,message:'Conflict'}});ws=new WebSocket(url.replace('http:','ws:')+'/websocket',{headers:{'X-Api-Key':'key'}});await once(ws,'open');const received=once(ws,'message');ws.send(JSON.stringify({jsonrpc:'2.0',method:'server.get_example',params:{v:5},id:2}));assert.deepEqual(JSON.parse(String((await received)[0])).result,{verb:'GET',v:5});assert.deepEqual(seen,['server.get_example','server.post_example','server.get_example','server.fail','server.get_example']);
 }finally{ws?.terminate();await service.close();}
});
