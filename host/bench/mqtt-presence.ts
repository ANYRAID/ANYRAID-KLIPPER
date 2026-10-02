import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {MqttSensors} from '../src/moonraker/mqtt-sensors.ts';
import {mqttPeer} from '../test/helpers/mqtt-peer.ts';
async function until(check:()=>boolean){const deadline=Date.now()+3000;while(!check()){assert.ok(Date.now()<deadline,'presence benchmark timed out');await new Promise<void>(r=>setImmediate(r));}}
const results=[];
for(const qos of [0,1,2] as const){
 const peer=await mqttPeer(),startTimes:number[]=[],closeTimes:number[]=[];let published=0,connections=0;
 try{
  for(let round=0;round<9;round++){
   let startup=0,shutdown=0;
   for(let i=0;i<20;i++){
    const transport=new MqttSensors({host:'127.0.0.1',port:peer.port,instanceName:'printer',defaultQos:qos},[]);transport.enablePresence();
    try{let start=performance.now();await transport.start();await until(()=>transport.status.presence.online);startup+=performance.now()-start;start=performance.now();await transport.close();shutdown+=performance.now()-start;assert.equal(transport.status.presence.failures,0);published+=2;connections++;}
    finally{await transport.close();}
   }
   await until(()=>peer.packets.filter(p=>p.cmd==='publish').length===published&&peer.packets.filter(p=>p.cmd==='disconnect').length===connections);
   if(round>=2){startTimes.push(startup);closeTimes.push(shutdown);}
  }
  for(const p of peer.packets.filter(p=>p.cmd==='publish')){assert.equal(p.topic,'printer/moonraker/status');assert.equal(p.retain,true);assert.equal(p.qos,qos);}
  const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[3],p95Ms:values[6]};};results.push({qos,startup:stats(startTimes),shutdown:stats(closeTimes)});
 }finally{await peer.close();}
}
console.log(JSON.stringify({node:process.version,connectionsPerRound:20,warmup:2,samples:7,scope:'TCP loopback CONNECT and retained online completion; retained offline acknowledgment and graceful DISCONNECT. No real broker, TLS, target board or printing.',results},null,2));
