import {test} from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {MqttSensors,type MqttProtocol} from '../src/moonraker/mqtt-sensors.ts';
import {mqttPeer} from './helpers/mqtt-peer.ts';
async function until(check:()=>boolean){const end=Date.now()+4000;while(!check()){assert.ok(Date.now()<end,'presence condition timed out');await new Promise(r=>setTimeout(r,5));}}
for(const protocol of ['v3.1','v3.1.1','v5'] as MqttProtocol[])test(`MQTT ${protocol} presence has retained offline will, online per connection and graceful offline ordering`,async()=>{
 const peer=await mqttPeer(),transport=new MqttSensors({host:'127.0.0.1',port:peer.port,protocol,instanceName:'printer',defaultQos:2,reconnectMs:10},[]);transport.enablePresence();
 try{
  await transport.start();await until(()=>transport.status.presence.online);
  const connect=peer.packets.find(p=>p.cmd==='connect');assert.ok(connect?.cmd==='connect');assert.equal(connect.will?.topic,'printer/moonraker/status');assert.equal(connect.will?.qos,2);assert.equal(connect.will?.retain,true);assert.deepEqual(JSON.parse(connect.will!.payload.toString()),{server:'offline'});
  peer.drop();await until(()=>transport.status.connections===2&&transport.status.presence.online);const publications=()=>peer.packets.filter(p=>p.cmd==='publish');assert.deepEqual(publications().map(p=>JSON.parse(p.payload.toString())),[{server:'online'},{server:'online'}]);
  const closing=transport.close();assert.equal(transport.status.closed,true);assert.equal(transport.close(),closing);await assert.rejects(transport.publish('room','new'),/not ready/);await closing;
  await until(()=>peer.packets.some(p=>p.cmd==='disconnect'));const last=publications().at(-1)!;assert.deepEqual(JSON.parse(last.payload.toString()),{server:'offline'});assert.equal(last.retain,true);assert.equal(last.qos,2);assert.equal(transport.status.presence.failures,0);assert.equal(peer.packets.at(-1)!.cmd,'disconnect');
 }finally{await transport.close();await peer.close();}
});
test('MQTT offline timeout closes without DISCONNECT so the broker can apply the will',async()=>{
 const peer=await mqttPeer({ackPublishes:false}),transport=new MqttSensors({host:'127.0.0.1',port:peer.port,instanceName:'printer',defaultQos:1,reconnectMs:10},[]);transport.enablePresence();
 try{
  await transport.start();await until(()=>peer.packets.some(p=>p.cmd==='publish'));const start=performance.now();await transport.close();const elapsed=performance.now()-start;assert.ok(elapsed>=1900&&elapsed<3500,`shutdown ${elapsed}ms`);
  assert.equal(peer.packets.some(p=>p.cmd==='disconnect'),false);assert.equal(transport.status.presence.failures,1);await until(()=>peer.sockets.size===0);assert.equal(peer.packets.filter(p=>p.cmd==='connect').length,1);
  assert.deepEqual(peer.packets.filter(p=>p.cmd==='publish').map(p=>JSON.parse(p.payload.toString())),[{server:'online'},{server:'offline'}]);
 }finally{await transport.close();await peer.close();}
});
test('Standalone sensor transport has no service presence and enablement is fenced by startup',async()=>{
 const peer=await mqttPeer(),transport=new MqttSensors({host:'127.0.0.1',port:peer.port},[]);
 try{await transport.start();assert.equal(transport.status.presence.enabled,false);assert.throws(()=>transport.enablePresence(),/before start/);const connect=peer.packets.find(p=>p.cmd==='connect');assert.ok(connect?.cmd==='connect');assert.equal(connect.will,undefined);assert.equal(peer.packets.some(p=>p.cmd==='publish'),false);}finally{await transport.close();await peer.close();}
});
