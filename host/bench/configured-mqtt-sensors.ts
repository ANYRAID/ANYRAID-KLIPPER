import {performance} from 'node:perf_hooks';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {MqttSensors} from '../src/moonraker/mqtt-sensors.ts';
import {SensorStore} from '../src/moonraker/sensors.ts';
import {SensorMessages} from '../src/moonraker/sensor-messages.ts';
import {mqttPeer} from '../test/helpers/mqtt-peer.ts';
const directory=await mkdtemp(join(tmpdir(),'configured-mqtt-bench-')),peer=await mqttPeer(),samples:Record<string,number[]>={manual:[],owned:[]};
try{
 const path=join(directory,'main.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');
 for(let run=0;run<9;run++)for(const mode of run%2?['owned','manual']:['manual','owned']){
  const start=performance.now();for(let i=0;i<10;i++){
   const sensors=new SensorStore();sensors.register({id:'room',type:'MQTT'});const receiver=new SensorMessages(sensors,'room',c=>c.setResult('t',c.payload)),transport=new MqttSensors({host:'127.0.0.1',port:peer.port},[{topic:'room',receiver}]);
   const service=await ConfiguredMoonraker.load(path,{authorize:()=>{},information:{connected:false,state:'disconnected',components:['application'],failedComponents:[],directories:[],warnings:[],version:'bench',missingRequirements:[]},sensors,...mode==='owned'?{sensorTransport:transport}:{}});
   try{if(mode==='manual')await transport.start();await service.start();assert.equal(transport.status.ready,true);}finally{if(mode==='manual')await transport.close();await service.close();}
   assert.equal(transport.status.closed,true);assert.equal(sensors.closed,true);assert.equal(receiver.status.closed,true);
  }if(run>=2)samples[mode].push(performance.now()-start);
 }
 const summary=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[3],p95Ms:v[6]};};console.log(JSON.stringify({node:process.version,warmup:2,samples:7,lifecycles:10,scope:'Load, real TCP MQTT connect/SUBACK, HTTP listen and complete close; explicit manual coordination versus server ownership',manual:summary(samples.manual),owned:summary(samples.owned)},null,2));
}finally{await peer.close();await rm(directory,{recursive:true,force:true});}
