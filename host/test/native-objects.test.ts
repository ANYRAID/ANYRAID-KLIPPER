import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {NativeObjects,registerNativeObjects} from '../src/moonraker/native-objects.ts';
import {JsonRpcDispatcher,ApiError} from '../src/moonraker/rpc.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
test('native query matches missing-object and missing-field rules and preserves precise values',()=>{
 let now=4,calls=0;const data={position:[1.005,-0,2.675,1e-9]},map=new Map([['toolhead',(time:number)=>{assert.equal(time,now);calls++;return data;}],['unused',()=>{throw new Error('Not requested');}]]),objects=new NativeObjects(map,()=>now);map.clear();assert.deepEqual(objects.list(),{objects:['toolhead','unused']});
 const reply=objects.query({toolhead:null,missing:null,unknown:['absent']});assert.equal(reply.eventtime,4);assert.deepEqual(reply.status,{toolhead:data,missing:{},unknown:{absent:null}});assert.equal(calls,1);data.position[0]=55;assert.deepEqual(reply.status.toolhead.position,[1.005,-0,2.675,1e-9]);
 now=5;assert.deepEqual(objects.query({toolhead:['position','absent','absent']}).status,{toolhead:{position:data.position,absent:null}});assert.equal(calls,2);assert.deepEqual(objects.query({toolhead:[]}).status,{toolhead:{}});assert.deepEqual(objects.query({}).status,{});
 now=3;assert.throws(()=>objects.query({}),e=>e instanceof ApiError&&e.status===503);
});
test('query rejects invalid filters, excessive fields, oversized results and asynchronous readers',async()=>{
 let calls=0;const objects=new NativeObjects(new Map([['data',()=>{calls++;return {text:'x'.repeat(1024*1024)};}]]),()=>1);
 for(const input of [undefined,[],{data:'text'},{data:[1]}])assert.throws(()=>objects.query(input),e=>e instanceof ApiError&&e.status===400);assert.equal(calls,0);
 const many=Object.fromEntries(Array.from({length:5},(_,i)=>['x'+i,Array.from({length:4096},(_,j)=>'f'+j)]));assert.throws(()=>objects.query(many),e=>e instanceof ApiError&&e.status===429);assert.equal(calls,0);assert.throws(()=>objects.query({data:null}),e=>e instanceof ApiError&&e.status===413);
 const throwing=new NativeObjects(new Map([['data',()=>({get secret():number{throw new Error('private getter');},safe:1})]]),()=>1);assert.deepEqual(throwing.query({data:['safe']}).status,{data:{safe:1}});assert.throws(()=>throwing.query({data:null}),e=>e instanceof ApiError&&e.status===503&&!e.message.includes('private'));
 const broken=new NativeObjects(new Map([['async',(()=>Promise.reject(new Error('private failure'))) as any]]),()=>1);assert.throws(()=>broken.query({async:null}),e=>e instanceof ApiError&&e.status===503&&!e.message.includes('private'));await new Promise(resolve=>setImmediate(resolve));
 const proto=new NativeObjects(new Map([['__proto__',()=>Object.fromEntries([['__proto__',42]])]]),()=>1);assert.deepEqual(proto.query(Object.fromEntries([['__proto__',null]])).status,Object.fromEntries([['__proto__',Object.fromEntries([['__proto__',42]])]]));
});
test('object registration rolls back collisions and authenticated REST/WS select identical fields',async()=>{
 const rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc);let calls=0;const objects=new NativeObjects(new Map([['gcode_move',()=>{calls++;return {speed:1500,position:[1.005,0,0,0]};}]]),()=>12.5);
 const collision=registry.register({endpoint:'objects/query',methods:['GET'],remote:true},()=>null);assert.throws(()=>registerNativeObjects(registry,objects));assert.equal(rpc.has('printer.objects.list'),false);collision();const remove=registerNativeObjects(registry,objects);
 const service=new MoonrakerNetwork(rpc,{endpoints:registry,authorize:(_m,_p,c)=>{if(c.request.headers['x-api-key']!=='test')throw new ApiError(401,'Denied');}}),address=await service.listen(),url=`http://127.0.0.1:${address.port}`;let ws:WebSocket|undefined;
 try{
  let response=await fetch(url+'/printer/objects/query?gcode_move=speed');assert.equal(response.status,401);await response.arrayBuffer();assert.equal(calls,0);
  response=await fetch(url+'/printer/objects/list',{headers:{'x-api-key':'test'}});assert.deepEqual((await response.json() as any).result,{objects:['gcode_move']});assert.equal(calls,0);
  response=await fetch(url+'/printer/objects/query?gcode_move=speed,missing&unknown',{headers:{'x-api-key':'test'}});const expected=(await response.json() as any).result;assert.deepEqual(expected,{eventtime:12.5,status:{gcode_move:{speed:1500,missing:null},unknown:{}}});
  ws=new WebSocket(url.replace('http:','ws:')+'/websocket',{headers:{'x-api-key':'test'}});await once(ws,'open');const received=once(ws,'message');ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'printer.objects.query',params:{objects:{gcode_move:['speed','missing'],unknown:null}}}));assert.deepEqual(JSON.parse(String((await received)[0])).result,expected);
 }finally{ws?.terminate();remove();remove();await service.close();}assert.equal(rpc.has('printer.objects.query'),false);
});
