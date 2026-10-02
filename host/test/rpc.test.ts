import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError,JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import type {RpcContext} from '../src/moonraker/rpc.ts';
const context=():RpcContext=>({transport:'websocket',signal:new AbortController().signal,authorize:()=>{}});
const req=(method:string,id:number|null=1,params:unknown={})=>JSON.stringify({jsonrpc:'2.0',id,method,params});
test('RPC dispatch enforces transport and authorization before handlers',async()=>{
  const rpc=new JsonRpcDispatcher();let calls=0;
  rpc.register('printer.test',['websocket'],()=>{calls++;return 'ok';});
  assert.equal(JSON.parse((await rpc.dispatch(req('printer.test'),context()))!).result,'ok');
  assert.equal(JSON.parse((await rpc.dispatch(req('printer.test'),{...context(),transport:'http'}))!).error.code,-32601);
  const denied={...context(),authorize:()=>{throw new ApiError(401,'Unauthorized');}};
  assert.equal(JSON.parse((await rpc.dispatch(req('printer.test'),denied))!).error.code,-32602);
  assert.equal(calls,1);
});
test('ordered batches omit successful notifications but preserve Moonraker notification errors',async()=>{
  const rpc=new JsonRpcDispatcher(),seen:number[]=[];
  rpc.register('append',['websocket'],async p=>{seen.push(p.n as number);return seen.length;});
  const response=await rpc.dispatch(JSON.stringify([{jsonrpc:'2.0',method:'append',params:{n:1}},{jsonrpc:'2.0',method:'append',params:{n:2},id:0},{jsonrpc:'2.0',method:'missing'}]),context());
  assert.deepEqual(seen,[1,2]);
  assert.deepEqual(JSON.parse(response!),[{jsonrpc:'2.0',result:2,id:0},{jsonrpc:'2.0',error:{code:-32601,message:'Method not found'},id:null}]);
  assert.equal(await rpc.dispatch('[]',context()),null);
});
test('parse, parameter, ID and input bounds fail deterministically',async()=>{
  const rpc=new JsonRpcDispatcher();rpc.register('test',['websocket'],()=>null);
  for(const [input,code] of [['{',-32700],['null',-32600],[req('test',1,[]),-32602],[JSON.stringify({jsonrpc:'2.0',method:'test',id:{a:1}}),-32600]] as const)
    assert.equal(JSON.parse((await rpc.dispatch(input,context()))!).error.code,code);
  assert.equal(JSON.parse((await rpc.dispatch(' '.repeat(1024*1024+1),context()))!).error.code,-32600);
});
test('null agent responses are delivered and internal errors cannot expose credentials',async()=>{
  const rpc=new JsonRpcDispatcher();let received:unknown;
  assert.equal(await rpc.dispatch('{"jsonrpc":"2.0","id":3,"result":null}',{...context(),receiveResponse:(id,response)=>{received={id,...response};}}),null);
  assert.deepEqual(received,{id:3,result:null});
  rpc.register('fail',['websocket'],()=>{throw new Error('token=SECRET');});
  const response=(await rpc.dispatch(req('fail'),context()))!;
  assert.equal(response.includes('SECRET'),false);assert.equal(JSON.parse(response).error.code,500);
});
test('cancelled requests never invoke handlers and invalid outputs are rejected',async()=>{
  const rpc=new JsonRpcDispatcher();let called=false;
  rpc.register('test',['websocket'],()=>{called=true;return NaN;});
  const abort=new AbortController();abort.abort();
  assert.equal(JSON.parse((await rpc.dispatch(req('test'),{...context(),signal:abort.signal}))!).error.code,500);
  assert.equal(called,false);
  assert.equal(JSON.parse((await rpc.dispatch(req('test'),context()))!).error.code,500);
});
test('shared JSON subobjects are accepted, cycles and late cancelled results are rejected',async()=>{
  const rpc=new JsonRpcDispatcher();const child={value:1};
  rpc.register('shared',['websocket'],()=>({left:child,right:child}));
  assert.deepEqual(JSON.parse((await rpc.dispatch(req('shared'),context()))!).result,{left:{value:1},right:{value:1}});
  const cycle:{[key:string]:any}={};cycle.self=cycle;
  rpc.register('cycle',['websocket'],()=>cycle);
  assert.equal(JSON.parse((await rpc.dispatch(req('cycle'),context()))!).error.code,500);
  const abort=new AbortController();
  rpc.register('cancel',['websocket'],()=>{abort.abort();return 'late success';});
  assert.equal(JSON.parse((await rpc.dispatch(req('cancel'),{...context(),signal:abort.signal}))!).error.message,'Request cancelled');
});
