import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {connect} from 'mqtt';
import {SensorStore} from '../src/moonraker/sensors.ts';
import {SensorMessages} from '../src/moonraker/sensor-messages.ts';
import {MqttSensors} from '../src/moonraker/mqtt-sensors.ts';
import {mqttPeer} from '../test/helpers/mqtt-peer.ts';
const times:Record<string,number[]>={direct:[],guarded:[]};
for(let run=0;run<9;run++)for(const mode of run%2?['guarded','direct']:['direct','guarded']){
 const peer=await mqttPeer(),store=new SensorStore();store.register({id:'room',type:'MQTT'});const receiver=new SensorMessages(store,'room',c=>c.setResult('t',c.payload));let close:()=>Promise<void>=async()=>{};
 try{
  if(mode==='guarded'){const client=new MqttSensors({host:'127.0.0.1',port:peer.port},[{topic:'room',receiver}]);close=()=>client.close();await client.start();}
  else{const client=connect(`mqtt://127.0.0.1:${peer.port}`,{reconnectPeriod:0});close=()=>client.endAsync(true);client.on('message',(_topic,payload)=>receiver.receive(payload));await new Promise<void>((resolve,reject)=>{client.once('error',reject);client.once('connect',()=>client.subscribe('room',error=>error?reject(error):resolve()));});}
  const start=performance.now();for(let i=0;i<10000;i++)peer.publish('room','2.675');const deadline=Date.now()+10000;while(receiver.status.accepted<10000){if(Date.now()>deadline)throw new Error('MQTT benchmark deadline');await new Promise<void>(r=>setImmediate(r));}if(run>=2)times[mode].push(performance.now()-start);assert.deepEqual(store.info('room').values,{t:2.675});assert.equal(receiver.status.rejected,0);
 }finally{await close();await peer.close();receiver.close();store.close();}
}
const summary=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[3],p95Ms:v[6]};};
console.log(JSON.stringify({node:process.version,mqtt:'5.16.0',warmup:2,samples:7,messages:10000,scope:'Real loopback TCP QoS 0, broker packet generation and decoded sensor updates included; direct MQTT.js vs bounded connection',direct:summary(times.direct),guarded:summary(times.guarded)},null,2));
