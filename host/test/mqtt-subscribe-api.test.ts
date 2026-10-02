import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,ApiError,type RpcContext} from '../src/moonraker/rpc.ts';
import {mqttSubscriptionPayload,registerMqttSubscribe} from '../src/moonraker/mqtt-api.ts';
const context=(extra:Partial<RpcContext>={}):RpcContext=>({transport:'http',signal:new AbortController().signal,authorize:()=>{},...extra});
test('MQTT response decoding preserves JSON versus text and refuses silent precision loss',()=>{
 for(const [text,value] of [['{"t":2.675}',{t:2.675}],['true',true],['null',null],['[1,2]',[1,2]],['"9007199254740993"','9007199254740993'],['9007199254740991',9007199254740991],['-0',-0],['hello','hello'],['',''],['{invalid','{invalid'],['\ufeff{"x":1}',{x:1}],['\ufefftext','\ufefftext']] as const)assert.deepEqual(mqttSubscriptionPayload(Buffer.from(text)),value);
 const sliced=Buffer.from('x{"v":3}z');assert.deepEqual(mqttSubscriptionPayload(new Uint8Array(sliced.buffer,sliced.byteOffset+1,sliced.byteLength-2)),{v:3});
 for(const value of [null,true,false,0,-123,0.125,'text',[],{},[1,false]])for(const prefix of ['',' ','\t\r\n','\ufeff \r\n'])assert.deepEqual(mqttSubscriptionPayload(Buffer.from(prefix+JSON.stringify(value))),value);
 for(const text of ['9007199254740993','{"n":-9007199254740993}','1e999','['.repeat(64)+'0'+']'.repeat(64)])assert.throws(()=>mqttSubscriptionPayload(Buffer.from(text)),error=>error instanceof ApiError&&error.status===422);
 assert.throws(()=>mqttSubscriptionPayload(Buffer.from([0xff])),/UTF-8/);assert.throws(()=>mqttSubscriptionPayload(Buffer.alloc(65537)),/byte limit/);
});
test('subscribe endpoint forwards cancellation and options after authorization, excluding MQTT RPC',async()=>{
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),ctx=context();let called=0;
 const release=registerMqttSubscribe(registry,{async waitForMessage(topic,options){called++;assert.equal(topic,'room');assert.equal(options.qos,2);assert.equal(options.timeoutMs,25);assert.equal(options.signal,ctx.signal);return Buffer.from('{"ok":true}');}});
 assert.deepEqual(await registry.invoke('/server/mqtt/subscribe','POST',{topic:'room',qos:'٢',timeout:'0.025'},ctx),{topic:'room',payload:{ok:true}});
 await assert.rejects(registry.invoke('/server/mqtt/subscribe','POST',{topic:'room'},context({authorize:()=>{throw new ApiError(401,'Unauthorized');}})),/Unauthorized/);
 await assert.rejects(registry.invoke('/server/mqtt/subscribe','POST',{topic:'room',timeout:0},ctx),/Subscribe Timed Out/);
 const denied=JSON.parse((await registry.dispatcher.dispatchValue({jsonrpc:'2.0',id:1,method:'server.mqtt.subscribe',params:{topic:'room'}},context({transport:'mqtt'})))!);assert.ok(denied.error);assert.equal(called,1);release();assert.equal(registry.dispatcher.has('server.mqtt.subscribe'),false);
});
