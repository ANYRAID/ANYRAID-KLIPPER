import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {MqttSensors,MqttPacketLimit} from '../src/moonraker/mqtt-sensors.ts';
import {SensorStore} from '../src/moonraker/sensors.ts';
import {SensorMessages} from '../src/moonraker/sensor-messages.ts';
import {mqttPeer} from './helpers/mqtt-peer.ts';
async function until(predicate:()=>boolean){const end=Date.now()+3000;while(!predicate()){if(Date.now()>end)throw new Error('MQTT condition timed out');await new Promise(r=>setTimeout(r,5));}}
const receiver=(store:SensorStore,id:string)=>{store.register({id,type:'MQTT'});return new SensorMessages(store,id,c=>c.setResult('t',c.payload));};
test('real TCP MQTT shares subscriptions, receives QoS 2 and reconnects without stale values',async()=>{
 const peer=await mqttPeer(),store=new SensorStore(),one=receiver(store,'one'),two=receiver(store,'two'),client=new MqttSensors({host:'127.0.0.1',port:peer.port,defaultQos:1,reconnectMs:20,timeoutMs:1000},[{topic:'room',qos:0,receiver:one},{topic:'room',qos:2,receiver:two}]);
 try{const opening=client.start();assert.equal(client.start(),opening);await opening;assert.deepEqual(peer.subscriptions,[{topic:'room',qos:2}]);peer.publish('room','22.5',2);await until(()=>one.status.accepted===1);assert.deepEqual(store.info('one').values,{t:22.5});assert.deepEqual(store.info('two').values,{t:22.5});await until(()=>peer.packets.some(p=>p.cmd==='pubcomp'));peer.drop();await until(()=>Object.keys(store.info('one').values).length===0);await until(()=>client.status.connections===2&&client.status.ready);assert.equal(peer.subscriptions.length,2);peer.publish('room','23');await until(()=>one.status.accepted===2);assert.deepEqual(store.info('two').values,{t:23});}
 finally{await client.close();await peer.close();}assert.equal(one.status.closed,true);assert.equal(client.status.ready,false);await client.close();assert.deepEqual(store.info('one').values,{});store.close();
});
test('subscription denial and oversized wire frame cannot become ready or publish data',async()=>{
 const denied=await mqttPeer({reject:true}),store=new SensorStore(),source=receiver(store,'one'),client=new MqttSensors({host:'127.0.0.1',port:denied.port,timeoutMs:80},[{topic:'room',receiver:source}]);try{await assert.rejects(client.start(),/timed out/);assert.equal(client.status.ready,false);}finally{await client.close();await denied.close();}
 const peer=await mqttPeer(),other=receiver(store,'two'),limited=new MqttSensors({host:'127.0.0.1',port:peer.port,maxPacketBytes:32,reconnectMs:1000,timeoutMs:500},[{topic:'room',receiver:other}]);try{await limited.start();for(const socket of peer.sockets)socket.write(Buffer.from([0x30,127]));await until(()=>!limited.status.connected);assert.equal(other.status.accepted,0);}finally{await limited.close();await peer.close();store.close();}
});
test('packet limit handles split lengths, coalesced packets and rejects malformed encodings',async()=>{
 const limit=new MqttPacketLimit(200),chunks:Buffer[]=[];limit.on('data',chunk=>chunks.push(chunk));limit.write(Buffer.from([0x30,0x80]));limit.write(Buffer.from([1]));limit.end(Buffer.concat([Buffer.alloc(128),Buffer.from([0xc0,0])]));await once(limit,'end');assert.equal(Buffer.concat(chunks).length,133);
 for(const bytes of [[0x30,0xff,0xff,0xff,0xff],[0x30,127]]){const guard=new MqttPacketLimit(32),failure=once(guard,'error');guard.resume();guard.end(Buffer.from(bytes));assert.match(String((await failure)[0]),/limit|length/);}
});
test('close before start and invalid bindings do not open broker connections',async()=>{
 const peer=await mqttPeer(),store=new SensorStore(),source=receiver(store,'one');try{for(const topic of ['room/#','room/+','bad\0name',''])assert.throws(()=>new MqttSensors({host:'127.0.0.1',port:peer.port},[{topic,receiver:source}]));const client=new MqttSensors({host:'127.0.0.1',port:peer.port},[{topic:'room',receiver:source}]);await client.close();await assert.rejects(client.start(),/closed/);assert.equal(peer.packets.length,0);}finally{await peer.close();store.close();}
});
test('explicit zero uses configured default QoS and closing startup rejects its waiter',async()=>{
 const peer=await mqttPeer(),store=new SensorStore(),source=receiver(store,'one'),client=new MqttSensors({host:'127.0.0.1',port:peer.port,defaultQos:1},[{topic:'room',qos:0,receiver:source}]);try{await client.start();assert.equal(peer.subscriptions[0].qos,1);}finally{await client.close();await peer.close();store.close();}
 const pendingStore=new SensorStore(),pendingSource=receiver(pendingStore,'one'),pending=new MqttSensors({host:'127.0.0.1',port:1,timeoutMs:1000},[{topic:'room',receiver:pendingSource}]);const failure=assert.rejects(pending.start(),/closed/);await pending.close();await failure;assert.equal(pending.status.connected,false);pendingStore.close();
});
