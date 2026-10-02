import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {SensorStore} from '../src/moonraker/sensors.ts';
import {MqttSensors} from '../src/moonraker/mqtt-sensors.ts';
import {mqttPublishPayload} from '../src/moonraker/mqtt-api.ts';
import {mqttPeer} from '../test/helpers/mqtt-peer.ts';
import {klippyMqttPeer} from '../test/helpers/klippy-mqtt-peer.ts';
async function until(check:()=>boolean){const deadline=Date.now()+5000;while(!check()){assert.ok(Date.now()<deadline,'macro benchmark timed out');await new Promise<void>(r=>setImmediate(r));}}
const dir=await mkdtemp(join(tmpdir(),'macro-bench-')),peer=await mqttPeer(),klippy=await klippyMqttPeer(),sensors=new SensorStore(),sensorTransport=new MqttSensors({host:'127.0.0.1',port:peer.port,instanceName:'printer'},[]);let service:ConfiguredMoonraker|undefined,direct=0,failures=0,sent=0;
try{
 const path=join(dir,'main.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');service=await ConfiguredMoonraker.load(path,{sensors,sensorTransport,authorize:()=>{},information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'bench',missingRequirements:[]}});await service.start();await service.attachKlippy(klippy.path,{remoteMethods:{bench_direct(params,signal){void sensorTransport.publish('printer/room',mqttPublishPayload(params.payload),{signal}).then(()=>{direct++;},()=>{failures++;});}}});
 const times:Record<string,number[]>={direct:[],bounded:[]};
 for(let run=0;run<9;run++)for(const mode of run%2?['bounded','direct']:['direct','bounded']){
  const count=()=>mode==='direct'?direct:service!.mqttMacroStatus!.completed,before=count(),start=performance.now();
  for(let batch=0;batch<8;batch++){for(let i=0;i<32;i++)klippy.send(mode==='direct'?'bench_direct':'publish_mqtt_topic',{topic:'room',payload:{t:2.675,index:batch*32+i},use_prefix:true});await until(()=>count()===before+(batch+1)*32);}
  sent+=256;await until(()=>peer.packets.filter(p=>p.cmd==='publish').filter(p=>!p.topic.endsWith('/moonraker/status')).length===sent);if(run>=2)times[mode].push(performance.now()-start);assert.equal(failures,0);assert.equal(service.mqttMacroStatus!.failed,0);assert.equal(service.mqttMacroStatus!.rejected,0);
  const packet=peer.packets.filter(p=>p.cmd==='publish').filter(p=>!p.topic.endsWith('/moonraker/status')).at(-1)!;assert.equal(packet.topic,'printer/room');assert.deepEqual(JSON.parse(packet.payload.toString()),{t:2.675,index:255});
 }
 const summary=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[3],p95Ms:v[6]};};console.log(JSON.stringify({node:process.version,calls:256,window:32,warmup:2,samples:7,scope:'Actual Unix Klippy callback to MQTT QoS 0 loopback, direct transport callback versus bounded macro adapter; excludes real G-code evaluation, TLS and printing',direct:summary(times.direct),bounded:summary(times.bounded)},null,2));
}finally{await service?.close();await sensorTransport.close();sensors.close();await peer.close();await klippy.close();await rm(dir,{recursive:true,force:true});}
