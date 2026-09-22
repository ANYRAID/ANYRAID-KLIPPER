import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {SensorStore} from '../src/moonraker/sensors.ts';
import {MqttSensors} from '../src/moonraker/mqtt-sensors.ts';
import {mqttPeer} from './helpers/mqtt-peer.ts';
import {klippyMqttPeer} from './helpers/klippy-mqtt-peer.ts';
async function until(check:()=>boolean){const end=Date.now()+3000;while(!check()){assert.ok(Date.now()<end,'status condition timed out');await new Promise(r=>setTimeout(r,5));}}
test('Configured MQTT status subscribes each Klippy generation and handles status while PUBACK is pending',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mqtt-status-')),peer=await mqttPeer({ackPublishes:false}),klippy=await klippyMqttPeer(),sensors=new SensorStore(),sensorTransport=new MqttSensors({host:'127.0.0.1',port:peer.port,instanceName:'printer',defaultQos:1},[]);let service:ConfiguredMoonraker|undefined;
 try{
  const path=join(dir,'main.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0\n[mqtt]\nstatus_objects=webhooks=state_message\npublish_split_status=true');
  service=await ConfiguredMoonraker.load(path,{sensors,sensorTransport,authorize:()=>{},information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]}});await service.start();await service.attachKlippy(klippy.path);
  await until(()=>peer.packets.some(p=>p.cmd==='publish'));const first:any=peer.packets.find(p=>p.cmd==='publish');assert.equal(first.topic,'printer/klipper/state/webhooks/state_message');assert.equal(first.retain,true);assert.deepEqual(JSON.parse(first.payload.toString()),{eventtime:1,value:'ready'});
  klippy.send('process_status_update',{eventtime:5,status:{webhooks:{state:'ready',state_message:'printing while broker waits'}}});await until(()=>service!.klippy?.stateMessage==='printing while broker waits');assert.equal(peer.packets.filter(p=>p.cmd==='publish').length,1);
  klippy.drop();await until(()=>service!.mqttStatus?.initialized===false);await service.reconnectKlippy();await until(()=>peer.packets.filter(p=>p.cmd==='publish').length===2);
  assert.equal(peer.packets.filter(p=>p.cmd==='publish').some((p:any)=>p.payload.toString().includes('printing while broker waits')),false);
  assert.ok(klippy.requests.filter(r=>r.method==='objects/subscribe').length>=4);assert.equal(service.mqttStatus?.initializationFailed,false);
 }finally{await service?.close();await sensorTransport.close();sensors.close();await peer.close();await klippy.close();await rm(dir,{recursive:true,force:true});}
});
