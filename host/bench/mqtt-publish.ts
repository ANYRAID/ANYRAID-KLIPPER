import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {connect} from 'mqtt';
import {MqttSensors} from '../src/moonraker/mqtt-sensors.ts';
import {mqttPeer} from '../test/helpers/mqtt-peer.ts';
const results=[],summary=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[3],p95Ms:v[6]};};
for(const qos of [0,1,2] as const){
 const times:Record<string,number[]>={direct:[],bounded:[]};
 for(let run=0;run<9;run++)for(const mode of run%2?['bounded','direct']:['direct','bounded']){
  const peer=await mqttPeer();let close:()=>Promise<void>=async()=>{},publish:()=>Promise<unknown>;
  try{
   if(mode==='bounded'){const client=new MqttSensors({host:'127.0.0.1',port:peer.port,protocol:'v5'},[]);close=()=>client.close();await client.start();publish=()=>client.publish('room','25.5',{qos});}
   else{const client=connect(`mqtt://127.0.0.1:${peer.port}`,{protocolVersion:5,reconnectPeriod:0});close=()=>client.endAsync(true);await new Promise<void>((resolve,reject)=>{client.once('error',reject);client.once('connect',()=>resolve());});publish=()=>client.publishAsync('room','25.5',{qos});}
   const start=performance.now();for(let i=0;i<8;i++)await Promise.all(Array.from({length:32},()=>publish()));
   const deadline=Date.now()+5000;while(peer.packets.filter(p=>p.cmd==='publish').length<256){assert.ok(Date.now()<deadline,'publish benchmark timed out');await new Promise<void>(r=>setImmediate(r));}
   if(run>=2)times[mode].push(performance.now()-start);const packets=peer.packets.filter(p=>p.cmd==='publish');assert.equal(packets.length,256);assert.ok(packets.every(p=>p.qos===qos&&p.payload.toString()==='25.5'));if(qos===2)assert.equal(peer.packets.filter(p=>p.cmd==='pubrel').length,256);
  }finally{await close();await peer.close();}
 }
 results.push({qos,direct:summary(times.direct),bounded:summary(times.bounded)});
}
console.log(JSON.stringify({node:process.version,protocol:'v5',publications:256,concurrency:32,warmup:2,samples:7,scope:'Real loopback publish and QoS acknowledgments, MQTT.js direct versus bounded no-replay publisher; excludes printing and TLS',results},null,2));
