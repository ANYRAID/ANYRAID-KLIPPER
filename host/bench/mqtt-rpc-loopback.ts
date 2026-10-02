import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {MqttRpc} from '../src/moonraker/mqtt-rpc.ts';
import {MqttSensors} from '../src/moonraker/mqtt-sensors.ts';
import {mqttPeer} from '../test/helpers/mqtt-peer.ts';
async function until(check:()=>boolean){const end=Date.now()+5000;while(!check()){assert.ok(Date.now()<end,'RPC benchmark timeout');await new Promise<void>(r=>setImmediate(r));}}
const count=256,times:Record<string,number[]>={direct:[],mqtt:[]};
for(let run=0;run<9;run++)for(const mode of run%2?['mqtt','direct']:['direct','mqtt']){
 const peer=await mqttPeer(),transport=new MqttSensors({host:'127.0.0.1',port:peer.port,instanceName:'printer'},[]),rpc=new JsonRpcDispatcher();let failures=0,calls=0;
 rpc.register('printer.status',['mqtt'],()=>{calls++;return {position:[1.23456789,2,3],temperature:215.125};});const api=new MqttRpc(rpc,transport,'printer',()=>{});
 transport.bindRpc(mode==='mqtt'?api.receive:(payload,_retain,signal)=>{void rpc.dispatch(payload,{transport:'mqtt',signal,authorize:()=>{}}).then(response=>response===null?undefined:transport.publish('printer/moonraker/api/response',response,{signal})).catch(()=>{failures++;});},0);
 try{
  await transport.start();const start=performance.now();for(let batch=0;batch<count/8;batch++){
   for(let i=0;i<8;i++){const id=batch*8+i;peer.publish('printer/moonraker/api/request',JSON.stringify({jsonrpc:'2.0',id,method:'printer.status',params:{mqtt_timestamp:id}}));}
   await until(()=>peer.packets.filter(p=>p.cmd==='publish').length===(batch+1)*8);
  }
  if(run>=2)times[mode].push(performance.now()-start);assert.equal(calls,count);assert.equal(failures,0);assert.equal(api.status.failed,0);assert.equal(api.status.rejected,0);
  const replies=peer.packets.filter(p=>p.cmd==='publish');assert.deepEqual(replies.map(p=>JSON.parse(p.payload.toString()).id).sort((a,b)=>a-b),Array.from({length:count},(_,i)=>i));for(const p of replies)assert.equal(JSON.parse(p.payload.toString()).result.temperature,215.125);
 }finally{await api.close();await transport.close();await peer.close();}
}
const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[3],p95Ms:v[6]};};console.log(JSON.stringify({node:process.version,calls:count,window:8,warmup:2,samples:7,scope:'Real TCP MQTT request/response through direct dispatcher vs bounded RPC adapter; minimal protocol peer, QoS 0, no production broker/TLS/printing.',direct:stats(times.direct),mqtt:stats(times.mqtt)},null,2));
