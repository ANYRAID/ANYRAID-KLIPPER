import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MqttSensors} from '../src/moonraker/mqtt-sensors.ts';
import {SensorMessages} from '../src/moonraker/sensor-messages.ts';
import {SensorStore} from '../src/moonraker/sensors.ts';
import {mqttPeer} from './helpers/mqtt-peer.ts';
import {mqttCertificate} from './helpers/mqtt-certificate.ts';
const setup=()=>{const store=new SensorStore();store.register({id:'room',type:'MQTT'});return {store,receiver:new SensorMessages(store,'room',c=>c.setResult('t',c.payload))};};
async function until(predicate:()=>boolean){const deadline=Date.now()+3000;while(!predicate()){if(Date.now()>deadline)throw new Error('TLS test timed out');await new Promise(r=>setTimeout(r,5));}}
test('TLS sensor connection validates trusted IP certificate and reestablishes encrypted subscription',async()=>{
 const tls=await mqttCertificate(),peer=await mqttPeer({tls}),{store,receiver}=setup(),client=new MqttSensors({host:'127.0.0.1',port:peer.port,tls:true,ca:tls.cert,reconnectMs:20,timeoutMs:1000},[{topic:'room',receiver}]);
 try{await client.start();peer.publish('room','24.125',1);await until(()=>receiver.status.accepted===1);assert.deepEqual(store.info('room').values,{t:24.125});peer.drop();await until(()=>Object.keys(store.info('room').values).length===0);await until(()=>client.status.connections===2&&client.status.ready);peer.publish('room','25');await until(()=>receiver.status.accepted===2);assert.deepEqual(store.info('room').values,{t:25});}
 finally{await client.close();await peer.close();store.close();}assert.equal(client.status.closed,true);
});
test('untrusted or wrong-host TLS certificate fails before sending MQTT credentials',async()=>{
 for(const mode of ['untrusted','wrong-host']){
  const tls=await mqttCertificate(mode==='wrong-host'?'DNS:wrong.invalid':'IP:127.0.0.1'),peer=await mqttPeer({tls}),{store,receiver}=setup(),client=new MqttSensors({host:'127.0.0.1',port:peer.port,tls:true,...mode==='wrong-host'?{ca:tls.cert}:{},username:'test-user',password:'test-only-password',timeoutMs:150,reconnectMs:20},[{topic:'room',receiver}]);
  try{await assert.rejects(client.start(),/timed out/);assert.equal(client.status.ready,false);assert.equal(peer.packets.length,0);assert.equal(receiver.status.accepted,0);assert.equal(JSON.stringify(client.status).includes('test-only-password'),false);}finally{await client.close();await peer.close();store.close();}
 }
});
test('CA configured on plaintext transport is rejected before creating a socket',()=>{const {store,receiver}=setup();assert.throws(()=>new MqttSensors({host:'127.0.0.1',ca:'certificate'},[{topic:'room',receiver}]),/connection option/);assert.equal(receiver.status.closed,false);store.close();});
test('DNS TLS connection supplies SNI and validates the DNS subject alternative name',async()=>{
 const tls=await mqttCertificate('DNS:localhost'),peer=await mqttPeer({tls}),{store,receiver}=setup(),client=new MqttSensors({host:'localhost',port:peer.port,tls:true,ca:tls.cert,timeoutMs:2000},[{topic:'room',receiver}]);
 try{await client.start();assert.equal(client.status.ready,true);assert.equal((Array.from(peer.sockets)[0] as any).servername,'localhost');peer.publish('room','26');await until(()=>receiver.status.accepted===1);assert.deepEqual(store.info('room').values,{t:26});}finally{await client.close();await peer.close();store.close();}
});
