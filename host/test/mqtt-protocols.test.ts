import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MqttSensors,type MqttProtocol} from '../src/moonraker/mqtt-sensors.ts';
import {SensorStore} from '../src/moonraker/sensors.ts';
import {SensorMessages} from '../src/moonraker/sensor-messages.ts';
import {mqttPeer} from './helpers/mqtt-peer.ts';
async function until(predicate:()=>boolean){const deadline=Date.now()+3000;while(!predicate()){assert.ok(Date.now()<deadline,'MQTT condition timed out');await new Promise(r=>setTimeout(r,5));}}
function resources(port:number,protocol:MqttProtocol,timeoutMs=1000){const store=new SensorStore();store.register({id:'room',type:'MQTT'});const receiver=new SensorMessages(store,'room',c=>c.setResult('t',c.payload));const client=new MqttSensors({host:'127.0.0.1',port,protocol,clientId:'version-test',username:'test-user',password:'test-pass',reconnectMs:20,timeoutMs},[{topic:'room',qos:2,receiver}]);return {store,receiver,client};}
for(const protocol of ['v3.1','v3.1.1','v5'] as const){
 test(`MQTT ${protocol} wire negotiation, QoS 0/1/2 and fresh reconnect`,async()=>{
  const peer=await mqttPeer(),{store,receiver,client}=resources(peer.port,protocol);
  try{
   await client.start();const connect=peer.packets.find(p=>p.cmd==='connect');assert.ok(connect?.cmd==='connect');assert.equal(connect.protocolVersion,protocol==='v5'?5:protocol==='v3.1'?3:4);assert.equal(connect.protocolId,protocol==='v3.1'?'MQIsdp':'MQTT');assert.equal(connect.clean,true);assert.equal(connect.username,'test-user');assert.equal(connect.password?.toString(),'test-pass');
   for(const qos of [0,1,2] as const){peer.publish('room',String(10+qos),qos);await until(()=>receiver.status.accepted===qos+1);assert.equal(store.info('room').values.t,10+qos);if(qos)await until(()=>peer.packets.some(p=>p.cmd===(qos===1?'puback':'pubcomp')));}
   if(protocol==='v5'){peer.send({cmd:'publish',topic:'room',payload:'13',qos:0,retain:true,dup:false,properties:{contentType:'text/plain',payloadFormatIndicator:true,userProperties:{source:'test'}}});await until(()=>receiver.status.accepted===4);assert.equal(store.info('room').values.t,13);}
   const accepted=receiver.status.accepted;peer.drop();await until(()=>client.status.connections===2&&client.status.ready);assert.deepEqual(store.info('room').values,{});assert.equal(peer.subscriptions.length,2);peer.publish('room','20');await until(()=>receiver.status.accepted===accepted+1);assert.equal(store.info('room').values.t,20);
  }finally{await client.close();await peer.close();store.close();}assert.equal(receiver.status.closed,true);assert.equal(client.status.connected,false);
 });
 test(`MQTT ${protocol} rejected connection and subscription clean up startup`,async()=>{
  for(const options of [{rejectConnection:true},{reject:true}]){const peer=await mqttPeer(options),{store,receiver,client}=resources(peer.port,protocol,100);try{await assert.rejects(client.start(),/timed out/);assert.equal(client.status.ready,false);await client.close();assert.equal(receiver.status.accepted,0);assert.equal(receiver.status.closed,true);}finally{await client.close();await peer.close();store.close();}}
 });
}
test('invalid MQTT protocol fails before acquiring a receiver',()=>{
 const store=new SensorStore();store.register({id:'room',type:'MQTT'});const receiver=new SensorMessages(store,'room',()=>{});
 assert.throws(()=>new MqttSensors({host:'localhost',protocol:'v6' as MqttProtocol},[{topic:'room',receiver}]),/protocol/);assert.equal(receiver.status.closed,false);receiver.close();store.close();
});
