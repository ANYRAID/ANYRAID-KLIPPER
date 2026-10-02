import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JsonRpcDispatcher,ApiError,type Json,type RpcContext} from '../src/moonraker/rpc.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {registerMqttPublish} from '../src/moonraker/mqtt-api.ts';
import type {MqttPublishOptions} from '../src/moonraker/mqtt-sensors.ts';
const context=(extra:Partial<RpcContext>={}):RpcContext=>({transport:'http',signal:new AbortController().signal,authorize:()=>{},...extra});
test('MQTT publish endpoint preserves JSON payload meaning and request conversions',async()=>{
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),calls:{topic:string;payload:string;options:MqttPublishOptions}[]=[],release=registerMqttPublish(registry,{async publish(topic,payload,options){calls.push({topic,payload,options});}});
 for(const [payload,expected] of [[null,''],['text','text'],[true,'true'],[false,'false'],[2.675,'2.675'],[-0,'-0.0'],[{t:1,b:true},'{"t":1,"b":true}'],[[1,2],'[1,2]']] as [Json,string][]){const ctx=context();assert.deepEqual(await registry.invoke('/server/mqtt/publish','POST',{topic:'room',payload,qos:'٢',retain:'TRUE',timeout:'٠.٠٥'},ctx),{topic:'room'});assert.equal(calls.at(-1)!.payload,expected);assert.equal(calls.at(-1)!.options.qos,2);assert.equal(calls.at(-1)!.options.retain,true);assert.equal(calls.at(-1)!.options.timeoutMs,50);assert.equal(calls.at(-1)!.options.signal,ctx.signal);}
 await registry.invoke('/server/mqtt/publish','POST',{topic:'room',qos:1.9},context());assert.equal(calls.at(-1)!.options.qos,1);assert.equal(calls.at(-1)!.payload,'');
 release();assert.equal(registry.dispatcher.has('server.mqtt.publish'),false);assert.equal(registry.allowed('/server/mqtt/publish'),undefined);
});
test('MQTT publication is authorized, rejects invalid inputs and excludes MQTT RPC transport',async()=>{
 const registry=new EndpointRegistry(new JsonRpcDispatcher());let writes=0;registerMqttPublish(registry,{async publish(){writes++;}});
 await assert.rejects(registry.invoke('/server/mqtt/publish','POST',{topic:'room'},context({authorize:()=>{throw new ApiError(401,'Unauthorized');}})),/Unauthorized/);
 for(const args of [{topic:12},{topic:'room',qos:3},{topic:'room',qos:'1.5'},{topic:'room',retain:'yes'},{topic:'room',timeout:null},{topic:'room',timeout:121},{topic:'room',timeout:0}] as Record<string,Json>[])await assert.rejects(registry.invoke('/server/mqtt/publish','POST',args,context()));
 const denied=JSON.parse((await registry.dispatcher.dispatchValue({jsonrpc:'2.0',id:1,method:'server.mqtt.publish',params:{topic:'room'}},context({transport:'mqtt'})))!);assert.ok(denied.error);assert.equal(writes,0);
});
