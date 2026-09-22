import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MqttSensors} from '../src/moonraker/mqtt-sensors.ts';
import {mqttPeer} from './helpers/mqtt-peer.ts';
async function until(check:()=>boolean){const deadline=Date.now()+3000;while(!check()){assert.ok(Date.now()<deadline,'MQTT condition timed out');await new Promise(r=>setTimeout(r,5));}}
for(const protocol of ['v3.1','v3.1.1','v5'] as const)test(`MQTT ${protocol} publishes bounded snapshots with QoS 0/1/2 acknowledgments`,async()=>{
 const peer=await mqttPeer(),client=new MqttSensors({host:'127.0.0.1',port:peer.port,protocol},[]);
 try{await assert.rejects(client.publish('room','offline'),/not ready/);await client.start();
  for(const qos of [0,1,2] as const){const payload=Buffer.from('original'),pending=client.publish('room',payload,{qos,retain:true});payload.fill(0);await pending;await until(()=>peer.packets.filter(p=>p.cmd==='publish').length===qos+1);const packet=peer.packets.filter(p=>p.cmd==='publish').at(-1)!;assert.equal(packet.cmd,'publish');if(packet.cmd==='publish'){assert.equal(packet.qos,qos);assert.equal(packet.retain,true);assert.equal(packet.payload.toString(),'original');}}
  await client.publish('room',Buffer.alloc(65536,65),{qos:1});const largest=peer.packets.filter(p=>p.cmd==='publish').at(-1)!;assert.ok(largest.cmd==='publish'&&Buffer.isBuffer(largest.payload)&&largest.payload.equals(Buffer.alloc(65536,65)));
  await client.publish('room','');await client.close();await assert.rejects(client.publish('room','closed'),/not ready/);
 }finally{await client.close();await peer.close();}
});
test('timed out, cancelled and disconnected publications never replay after reconnect',async()=>{
 const peer=await mqttPeer({ackPublishes:false}),client=new MqttSensors({host:'127.0.0.1',port:peer.port,reconnectMs:20},[]);
 try{await client.start();await assert.rejects(client.publish('room','timeout',{qos:1,timeoutMs:30}),/timed out/);
  const controller=new AbortController(),pending=client.publish('room','cancel',{qos:2,signal:controller.signal});const cancelled=assert.rejects(pending,/cancelled/);await until(()=>peer.packets.filter(p=>p.cmd==='publish').length===2);controller.abort();await cancelled;
  const lost=assert.rejects(client.publish('room','lost',{qos:1}),/disconnected/);await until(()=>peer.packets.filter(p=>p.cmd==='publish').length===3);peer.drop();await lost;await until(()=>client.status.connections===2&&client.status.ready);
  await client.publish('room','new',{qos:0});await until(()=>peer.packets.filter(p=>p.cmd==='publish').length>=4);assert.deepEqual(peer.packets.filter(p=>p.cmd==='publish').map(p=>p.payload.toString()),['timeout','cancel','lost','new']);
 }finally{await client.close();await peer.close();}
});
test('publication capacity, input checks, close and MQTT 5 negative acknowledgments settle waiters',async()=>{
 const peer=await mqttPeer({ackPublishes:false}),client=new MqttSensors({host:'127.0.0.1',port:peer.port,defaultQos:1},[]);
 try{await client.start();for(const topic of ['','a/#','a/+','a\0b'])await assert.rejects(client.publish(topic,'x'),/topic/);await assert.rejects(client.publish('room',Buffer.alloc(65537)),/byte limit/);await assert.rejects(client.publish('room','\ud800'),/payload/);await assert.rejects(client.publish('room','x',{signal:AbortSignal.abort()}),/cancelled/);
  const pending=Array.from({length:32},()=>assert.rejects(client.publish('room','queued',{qos:0}),/closed/));await assert.rejects(client.publish('room','overflow'),/capacity/);await until(()=>peer.packets.filter(p=>p.cmd==='publish').length===32);assert.ok(peer.packets.filter(p=>p.cmd==='publish').every(p=>p.qos===1));await client.close();await Promise.all(pending);
 }finally{await client.close();await peer.close();}
 const denied=await mqttPeer({publishReasonCode:135}),other=new MqttSensors({host:'127.0.0.1',port:denied.port,protocol:'v5'},[]);try{await other.start();await assert.rejects(other.publish('room','denied',{qos:1}),/failed/);await assert.rejects(other.publish('room','denied-phase-two',{qos:2}),/failed/);}finally{await other.close();await denied.close();}
});
test('QoS 2 disconnect after PUBREC removes stored PUBREL rather than replaying completion',async()=>{
 const peer=await mqttPeer({ackCompletions:false}),client=new MqttSensors({host:'127.0.0.1',port:peer.port,protocol:'v5',reconnectMs:20},[]);
 try{await client.start();const failed=assert.rejects(client.publish('room','phase-two',{qos:2}),/disconnected/);await until(()=>peer.packets.some(p=>p.cmd==='pubrel'));peer.drop();await failed;await until(()=>client.status.connections===2&&client.status.ready);await client.publish('room','new');await until(()=>peer.packets.filter(p=>p.cmd==='publish').length===2);assert.equal(peer.packets.filter(p=>p.cmd==='pubrel').length,1);assert.equal(peer.packets.filter(p=>p.cmd==='publish'&&p.qos===2).length,1);}
 finally{await client.close();await peer.close();}
});
