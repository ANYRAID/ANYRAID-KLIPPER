import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {connect} from 'mqtt';
import {MqttSensors} from '../src/moonraker/mqtt-sensors.ts';
import {mqttPeer} from '../test/helpers/mqtt-peer.ts';
async function until(check:()=>boolean){const deadline=Date.now()+5000;while(!check()){assert.ok(Date.now()<deadline,'benchmark timed out');await new Promise<void>(r=>setImmediate(r));}}
const times:Record<string,number[]>={direct:[],bounded:[]};
for(let run=0;run<9;run++)for(const mode of run%2?['bounded','direct']:['direct','bounded']){
 const peer=await mqttPeer();let close:()=>Promise<void>=async()=>{},batch:()=>Promise<Buffer[]>;
 try{
  if(mode==='bounded'){const client=new MqttSensors({host:'127.0.0.1',port:peer.port},[]);await client.start();close=()=>client.close();batch=()=>Promise.all(Array.from({length:32},()=>client.waitForMessage('room')));}
  else{const client=connect(`mqtt://127.0.0.1:${peer.port}`,{reconnectPeriod:0});client.setMaxListeners(64);close=()=>client.endAsync(true);await new Promise<void>((resolve,reject)=>{client.once('error',reject);client.once('connect',()=>resolve());});batch=async()=>{const pending=Promise.all(Array.from({length:32},()=>new Promise<Buffer>(resolve=>client.once('message',(_topic,bytes)=>resolve(Buffer.from(bytes))))));client.subscribe('room');const result=await pending;client.unsubscribe('room');return result;};}
  const start=performance.now();for(let i=0;i<8;i++){const result=batch();await until(()=>peer.subscriptions.length===i+1);peer.publish('room','25.5');assert.ok((await result).every(bytes=>bytes.toString()==='25.5'));await until(()=>peer.packets.filter(p=>p.cmd==='unsubscribe').length===i+1);}if(run>=2)times[mode].push(performance.now()-start);
 }finally{await close();await peer.close();}
}
const summary=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[3],p95Ms:v[6]};};console.log(JSON.stringify({node:process.version,waiters:256,concurrency:32,topicMessages:8,warmup:2,samples:7,scope:'Loopback exact-topic SUBSCRIBE, fan-out to 32 waiters, copies and UNSUBSCRIBE; MQTT.js direct vs bounded lifetime; no TLS or printing',direct:summary(times.direct),bounded:summary(times.bounded)},null,2));
