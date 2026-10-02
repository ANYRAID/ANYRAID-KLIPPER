import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {MqttSensors} from '../src/moonraker/mqtt-sensors.ts';
import {SensorMessages} from '../src/moonraker/sensor-messages.ts';
import {SensorStore} from '../src/moonraker/sensors.ts';
import {mqttPeer} from '../test/helpers/mqtt-peer.ts';
import {mqttCertificate} from '../test/helpers/mqtt-certificate.ts';
const certificate=await mqttCertificate(),samples:Record<string,{startup:number[];receive:number[];close:number[]}>={tcp:{startup:[],receive:[],close:[]},tls:{startup:[],receive:[],close:[]}};
for(let run=0;run<9;run++)for(const mode of run%2?['tls','tcp']:['tcp','tls']){
 const peer=await mqttPeer(mode==='tls'?{tls:certificate}:{}),store=new SensorStore();store.register({id:'room',type:'MQTT'});const receiver=new SensorMessages(store,'room',c=>c.setResult('t',c.payload)),client=new MqttSensors({host:'127.0.0.1',port:peer.port,...mode==='tls'?{tls:true,ca:certificate.cert}:{}},[{topic:'room',receiver}]);
 try{
  let start=performance.now();await client.start();const startup=performance.now()-start;start=performance.now();for(let i=0;i<10000;i++)peer.publish('room','24.125');const deadline=Date.now()+10000;while(receiver.status.accepted<10000){if(Date.now()>deadline)throw new Error('TLS benchmark deadline');await new Promise<void>(r=>setImmediate(r));}const receive=performance.now()-start;assert.deepEqual(store.info('room').values,{t:24.125});assert.equal(receiver.status.rejected,0);start=performance.now();await client.close();const close=performance.now()-start;if(run>=2){samples[mode].startup.push(startup);samples[mode].receive.push(receive);samples[mode].close.push(close);}
 }finally{await client.close();await peer.close();store.close();}
}
const summary=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[3],p95Ms:v[6]};};
console.log(JSON.stringify({node:process.version,warmup:2,samples:7,messages:10000,scope:'Loopback TCP versus certificate-validated TLS, fresh connections, real MQTT subscription and sensor updates; certificate generation excluded',results:Object.fromEntries(Object.entries(samples).map(([mode,phases])=>[mode,Object.fromEntries(Object.entries(phases).map(([phase,times])=>[phase,summary(times)]))]))},null,2));
