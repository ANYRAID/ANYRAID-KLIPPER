import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MqttMacroPublisher} from '../src/moonraker/mqtt-macros.ts';
import type {Json} from '../src/moonraker/rpc.ts';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('macro MQTT publication preserves prefix and payload semantics without returning a pending callback',async()=>{
 const calls:unknown[]=[],macro=new MqttMacroPublisher({async publish(topic,payload,options){calls.push({topic,payload,qos:options.qos,retain:options.retain});}},'printer');const generation=new AbortController();
 assert.equal(macro.invoke({topic:'///room',payload:{t:2.675},qos:2,retain:true,use_prefix:true},generation.signal),undefined);macro.invoke({topic:'raw',payload:false},generation.signal);await tick();assert.deepEqual(calls,[{topic:'printer/room',payload:'{"t":2.675}',qos:2,retain:true},{topic:'raw',payload:'false',qos:undefined,retain:false}]);assert.equal(macro.status.completed,2);await macro.close();
});
test('macro publication failures are contained and invalid or excess calls do not enter the broker',async()=>{
 let called=0;const macro=new MqttMacroPublisher({publish(){called++;throw new Error('private publisher detail');}},'printer'),signal=new AbortController().signal;
 for(const params of [{topic:3},{topic:'room',qos:4},{topic:'room',retain:'true'},{topic:'room',use_prefix:'false'}] as Record<string,Json>[])macro.invoke(params,signal);
 for(let i=0;i<33;i++)macro.invoke({topic:'room'},signal);assert.equal(macro.status.rejected,5);await tick();assert.equal(called,32);assert.equal(macro.status.failed,32);assert.equal(macro.status.pending,0);assert.ok(!JSON.stringify(macro.status).includes('private'));await macro.close();
});
test('Klippy generation and server close cancel outstanding macro publications without replay',async()=>{
 const macro=new MqttMacroPublisher({publish(_t,_p,{signal}){return new Promise((_resolve,reject)=>{if(signal!.aborted)reject(new Error('cancelled'));else signal!.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});});}},'printer'),first=new AbortController(),second=new AbortController();
 macro.invoke({topic:'first'},first.signal);await tick();first.abort();await tick();assert.equal(macro.status.cancelled,1);macro.invoke({topic:'second'},second.signal);await tick();await macro.close();assert.equal(macro.status.cancelled,2);assert.equal(macro.status.pending,0);macro.invoke({topic:'closed'},second.signal);assert.equal(macro.status.cancelled,3);
});
