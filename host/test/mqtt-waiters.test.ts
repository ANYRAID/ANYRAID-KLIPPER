import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MqttSensors} from '../src/moonraker/mqtt-sensors.ts';
import {SensorStore} from '../src/moonraker/sensors.ts';
import {SensorMessages} from '../src/moonraker/sensor-messages.ts';
import {mqttPeer} from './helpers/mqtt-peer.ts';
async function until(check:()=>boolean){const deadline=Date.now()+3000;while(!check()){assert.ok(Date.now()<deadline,'MQTT condition timed out');await new Promise(r=>setTimeout(r,5));}}
for(const protocol of ['v3.1','v3.1.1','v5'] as const)test(`MQTT ${protocol} shares one-shot subscription, upgrades QoS and isolates returned bytes`,async()=>{
 const peer=await mqttPeer(),client=new MqttSensors({host:'127.0.0.1',port:peer.port,protocol},[]);
 try{await client.start();const first=client.waitForMessage('room',{qos:1}),second=client.waitForMessage('room',{qos:2}),third=client.waitForMessage('room',{qos:1});await until(()=>peer.subscriptions.length===2);assert.deepEqual(peer.subscriptions.map(s=>s.qos),[1,2]);peer.publish('room','25.5',2);const values=await Promise.all([first,second,third]);assert.ok(values.every(v=>v.toString()==='25.5'));values[0].fill(0);assert.equal(values[1].toString(),'25.5');await until(()=>peer.packets.some(p=>p.cmd==='unsubscribe'));assert.equal(peer.packets.filter(p=>p.cmd==='unsubscribe').length,1);assert.equal(client.status.waiting,0);
  const next=client.waitForMessage('room');await until(()=>peer.subscriptions.length===3);peer.publish('room','26');assert.equal((await next).toString(),'26');
 }finally{await client.close();await peer.close();}
});
test('one-shot cancellation preserves fixed sensors and their upgraded QoS on reconnect',async()=>{
 const peer=await mqttPeer(),store=new SensorStore();store.register({id:'room',type:'MQTT'});const receiver=new SensorMessages(store,'room',c=>c.setResult('t',c.payload)),client=new MqttSensors({host:'127.0.0.1',port:peer.port,reconnectMs:20},[{topic:'room',receiver}]);
 try{await client.start();const abort=new AbortController(),cancelled=assert.rejects(client.waitForMessage('room',{qos:2,signal:abort.signal}),/cancelled/);await until(()=>peer.subscriptions.length===2);abort.abort();await cancelled;assert.equal(peer.packets.filter(p=>p.cmd==='unsubscribe').length,0);peer.publish('room','22');await until(()=>receiver.status.accepted===1);peer.drop();await until(()=>client.status.connections===2&&client.status.ready);assert.equal(peer.subscriptions.at(-1)!.qos,2);peer.publish('room','23');await until(()=>receiver.status.accepted===2);assert.equal(store.info('room').values.t,23);
 }finally{await client.close();await peer.close();store.close();}
});
test('timeouts, disconnect, close and payload bounds settle temporary waiters without replay',async()=>{
 const peer=await mqttPeer(),client=new MqttSensors({host:'127.0.0.1',port:peer.port,reconnectMs:20},[]);
 try{await assert.rejects(client.waitForMessage('room'),/not ready/);await client.start();await assert.rejects(client.waitForMessage('room',{timeoutMs:20}),/Timed Out/);await until(()=>peer.packets.some(p=>p.cmd==='unsubscribe'));
  const lost=assert.rejects(client.waitForMessage('lost'),/connection closed/);await until(()=>peer.subscriptions.some(s=>s.topic==='lost'));peer.drop();await lost;await until(()=>client.status.connections===2&&client.status.ready);assert.equal(peer.subscriptions.filter(s=>s.topic==='lost').length,1);
  const oversized=assert.rejects(client.waitForMessage('large'),/byte limit/);await until(()=>peer.subscriptions.some(s=>s.topic==='large'));peer.publish('large','x'.repeat(65537));await oversized;
  const pending=Array.from({length:32},()=>assert.rejects(client.waitForMessage('closing'),/connection closed/));await assert.rejects(client.waitForMessage('overflow'),/capacity/);await client.close();await Promise.all(pending);assert.equal(client.status.waiting,0);
 }finally{await client.close();await peer.close();}
});
test('rejected SUBACK and invalid topics fail without leaking temporary handles',async()=>{
 const peer=await mqttPeer({reject:true}),client=new MqttSensors({host:'127.0.0.1',port:peer.port},[]);
 try{await client.start();for(const topic of ['','a/+','a/#','a\0b'])await assert.rejects(client.waitForMessage(topic),/topic/);await assert.rejects(client.waitForMessage('room'),/rejected/);assert.equal(client.status.waiting,0);await until(()=>peer.packets.some(p=>p.cmd==='unsubscribe'));}
 finally{await client.close();await peer.close();}
});
test('missing subscription acknowledgments force a clean connection and release control state',async()=>{
 for(const options of [{ackSubscriptions:false},{ackUnsubscriptions:false}]){
  const peer=await mqttPeer(options),client=new MqttSensors({host:'127.0.0.1',port:peer.port,timeoutMs:60,reconnectMs:20},[]);
  try{await client.start();if(options.ackSubscriptions===false)await assert.rejects(client.waitForMessage('room'),/connection closed/);else{const received=client.waitForMessage('room');await until(()=>peer.subscriptions.length===1);peer.publish('room','done');assert.equal((await received).toString(),'done');}await until(()=>client.status.connections===2&&client.status.ready);assert.equal(client.status.waiting,0);assert.equal(peer.subscriptions.length,1);}
  finally{await client.close();await peer.close();}
 }
});
test('late rejected SUBACK from a cancelled wait cannot reject its replacement',async()=>{
 const peer=await mqttPeer({ackSubscriptions:false}),client=new MqttSensors({host:'127.0.0.1',port:peer.port},[]);
 try{await client.start();const abort=new AbortController(),old=assert.rejects(client.waitForMessage('room',{signal:abort.signal}),/cancelled/);await until(()=>peer.subscriptions.length===1);abort.abort();await old;const replacement=client.waitForMessage('room',{qos:1});await until(()=>peer.subscriptions.length===2);const packets=peer.packets.filter(p=>p.cmd==='subscribe');peer.send({cmd:'suback',messageId:packets[0].messageId,granted:[128]});peer.send({cmd:'suback',messageId:packets[1].messageId,granted:[1]});peer.publish('room','replacement');assert.equal((await replacement).toString(),'replacement');assert.equal(client.status.waiting,0);}
 finally{await client.close();await peer.close();}
});
