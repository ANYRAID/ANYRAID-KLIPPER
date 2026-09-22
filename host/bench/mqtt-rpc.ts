import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {MqttRpc} from '../src/moonraker/mqtt-rpc.ts';
const count=10000,signal=new AbortController().signal,times:Record<string,number[]>={direct:[],mqtt:[]};
for(let run=0;run<9;run++)for(const mode of run%2?['mqtt','direct']:['direct','mqtt']){
 const rpc=new JsonRpcDispatcher();let calls=0,replies=0;rpc.register('printer.status',['mqtt'],()=>{calls++;return {position:[1.23456789,2,3],temperature:215.125};});
 const publisher={async publish(_topic:string,payload:string){assert.equal(JSON.parse(payload).result.temperature,215.125);replies++;}};
 const api=new MqttRpc(rpc,publisher,'printer',()=>{});const frames=Array.from({length:count},(_,i)=>Buffer.from(JSON.stringify({jsonrpc:'2.0',id:i,method:'printer.status',params:{mqtt_timestamp:i}})));
 const start=performance.now();for(const frame of frames){if(mode==='direct'){const response=await rpc.dispatch(frame,{transport:'mqtt',signal,authorize:()=>{}});await publisher.publish('',response!);}else{api.receive(frame,false,signal);while(api.status.pending)await Promise.resolve();}}
 const elapsed=performance.now()-start;assert.equal(calls,count);assert.equal(replies,count);assert.equal(api.status.failed,0);assert.equal(api.status.rejected,0);await api.close();if(run>=2)times[mode].push(elapsed);
}
const summary=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[3],p95Ms:v[6]};};console.log(JSON.stringify({node:process.version,calls:count,warmup:2,samples:7,scope:'Prebuilt UTF-8 requests through JSON-RPC, authorization, handler and response encoding; MQTT adapter adds bounded admission, timestamp screening and generation cancellation. In-memory publisher; no network/Python/printing baseline.',direct:summary(times.direct),mqtt:summary(times.mqtt)},null,2));
