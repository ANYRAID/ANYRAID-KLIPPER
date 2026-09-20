import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseRequestJson,JsonNumberError} from '../src/moonraker/json.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {parseRestArguments,EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
import {once} from 'node:events';
import {WebSocket} from 'ws';
test('integer tokens beyond safe range are rejected before precision can be lost',()=>{
 for(const n of ['9007199254740992','9007199254740993','-9007199254740992','-9007199254740993','18446744073709551615','9'.repeat(400)])for(const wrap of [(n:string)=>n,(n:string)=>`{"clock":${n}}`,(n:string)=>`[0,{"nested":[${n}]}]`])assert.throws(()=>parseRequestJson(wrap(n)),JsonNumberError);
 assert.deepEqual(parseRequestJson('[9007199254740991,-9007199254740991,0,-0]'),[Number.MAX_SAFE_INTEGER,Number.MIN_SAFE_INTEGER,0,-0]);
});
test('exact integer strings and finite floating tokens retain their declared JSON semantics',()=>{
 const input='{"clock":"9007199254740993","escaped":"\\u0039007199254740993","fraction":9007199254740993.0,"exponent":9007199254740993e0,"small":1e-309,"quote":"\\\"12345678901234567"}';assert.deepEqual(parseRequestJson(input),JSON.parse(input));for(const x of ['1e309','-1E+9999','1e0000309'])assert.throws(()=>parseRequestJson(x),JsonNumberError);assert.equal(parseRequestJson('1e308'),1e308);
});
test('RPC number rejection invokes neither authorization nor handlers, including an entire batch',async()=>{
 const rpc=new JsonRpcDispatcher();let calls=0,auth=0;rpc.register('move',['http'],()=>{calls++;return 'ok';});const context={transport:'http' as const,signal:new AbortController().signal,authorize(){auth++;}};
 const bad='{"jsonrpc":"2.0","method":"move","params":{"clock":9007199254740993},"id":1}';for(const input of [bad,`[{"jsonrpc":"2.0","method":"move","id":2},${bad}]`])assert.equal(JSON.parse((await rpc.dispatch(input,context))!).error.code,-32600);assert.equal(calls,0);assert.equal(auth,0);assert.equal(JSON.parse((await rpc.dispatch('{',context))!).error.code,-32700);
});
test('REST rejects unsafe JSON bodies while JSON hints preserve their full original text',()=>{
 assert.throws(()=>parseRestArguments('clock:int=1',Buffer.from('{"clock":9007199254740993}'),'application/json'),/safe range/);assert.throws(()=>parseRestArguments('',Buffer.from('{"clock":1e309}'),'application/json'),/finite/);
 assert.equal(parseRestArguments('data:json=%7B%22clock%22%3A9007199254740993%7D',Buffer.alloc(0),'').data,'{"clock":9007199254740993}');assert.equal(parseRestArguments('',Buffer.from('{"clock":"9007199254740993"}'),'application/json').clock,'9007199254740993');
});
test('HTTP REST and websocket RPC cannot deliver rounded clock arguments to a business handler',async()=>{
 const rpc=new JsonRpcDispatcher(),endpoints=new EndpointRegistry(rpc);let calls=0;endpoints.register({endpoint:'/printer/move',methods:['POST']},()=>{calls++;return null;});const server=new MoonrakerNetwork(rpc,{endpoints,authorize(){}}),address=await server.listen(),url=`http://127.0.0.1:${address.port}`;let ws:WebSocket|undefined;
 try{const response=await fetch(url+'/printer/move',{method:'POST',headers:{'content-type':'application/json'},body:'{"clock":9007199254740993}'});assert.equal(response.status,400);ws=new WebSocket(url.replace('http:','ws:')+'/websocket');await once(ws,'open');const reply=once(ws,'message');ws.send('{"jsonrpc":"2.0","method":"printer.move","params":{"clock":9007199254740993},"id":1}');assert.equal(JSON.parse(String((await reply)[0])).error.code,-32600);assert.equal(calls,0);}finally{ws?.terminate();await server.close();}
});
test('source scanning handles escaped quotes, slash runs, numeric keys and discarded duplicate values',()=>{
 const strings=['9007199254740993','1e999','\\','\\\\','"','\\"','\\\\"','end\\','\n"9007199254740993'];
 for(const text of strings){const source=JSON.stringify({'9007199254740993':text,array:[text,{number:1e100}]});assert.deepEqual(parseRequestJson(source),JSON.parse(source));}
 assert.throws(()=>parseRequestJson('{"clock":9007199254740993,"clock":1}'),JsonNumberError);
 assert.throws(()=>parseRequestJson('{"clock":9007199254740993,}'),SyntaxError);
 const long=JSON.stringify({text:'\\"9007199254740993'.repeat(10000)});assert.deepEqual(parseRequestJson(long),JSON.parse(long));
});
