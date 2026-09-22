import {test} from 'node:test';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {SensorStore} from '../src/moonraker/sensors.ts';
import {MqttSensors} from '../src/moonraker/mqtt-sensors.ts';
import {mqttPeer} from './helpers/mqtt-peer.ts';
import {klippyMqttPeer} from './helpers/klippy-mqtt-peer.ts';
async function until(check:()=>boolean){const deadline=Date.now()+3000;while(!check()){assert.ok(Date.now()<deadline,'macro condition timed out');await new Promise(r=>setTimeout(r,5));}}
test('Klippy MQTT method registers per generation, contains broker failures and cancels old in-flight messages',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'configured-mqtt-macro-')),peer=await mqttPeer({ackPublishes:false}),klippy=await klippyMqttPeer(),sensors=new SensorStore(),sensorTransport=new MqttSensors({host:'127.0.0.1',port:peer.port,instanceName:'printer'},[]);let service:ConfiguredMoonraker|undefined;
 try{
  const path=join(dir,'main.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');service=await ConfiguredMoonraker.load(path,{sensors,sensorTransport,authorize:()=>{},information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]}});const address=await service.start();
  const agent=new WebSocket(`ws://127.0.0.1:${address.port}/websocket`);try{await once(agent,'open');for(const [id,method,params] of [[1,'server.connection.identify',{client_name:'worker',type:'agent',version:'1',url:''}],[2,'server.connection.register_remote_method',{method_name:'publish_mqtt_topic'}]] as const){const reply=once(agent,'message',{signal:AbortSignal.timeout(3000)});agent.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));const result=JSON.parse((await reply)[0].toString());if(id===1)assert.equal(result.error,undefined);else assert.match(result.error.message,/Invalid or duplicate remote method/);}}finally{agent.terminate();}
  assert.throws(()=>service!.attachKlippy(klippy.path,{remoteMethods:{publish_mqtt_topic:()=>{}}}),/reserved/);await service.attachKlippy(klippy.path);assert.ok(service.klippyRemoteMethods?.registered.includes('publish_mqtt_topic'));
  klippy.send('publish_mqtt_topic',{topic:'///room',payload:{t:2.675},use_prefix:true});await until(()=>service!.mqttMacroStatus?.completed===1&&peer.packets.some(p=>p.cmd==='publish'&&p.topic==='printer/room'));const packet=peer.packets.find(p=>p.cmd==='publish'&&!p.topic.endsWith('/moonraker/status'));assert.ok(packet?.cmd==='publish');assert.equal(packet.topic,'printer/room');assert.deepEqual(JSON.parse(packet.payload.toString()),{t:2.675});
  klippy.send('publish_mqtt_topic',{topic:'bad/#'});await until(()=>service!.mqttMacroStatus?.failed===1);assert.ok(service.klippyRemoteMethods?.registered.includes('publish_mqtt_topic'));
  klippy.send('publish_mqtt_topic',{topic:'pending',payload:'old',qos:1});await until(()=>service!.mqttMacroStatus?.pending===1&&peer.packets.filter(p=>p.cmd==='publish').filter(p=>!p.topic.endsWith('/moonraker/status')).length===2);klippy.send('process_status_update',{eventtime:2,status:{webhooks:{state:'ready',state_message:'status while MQTT waits'}}});await until(()=>service!.klippy?.stateMessage==='status while MQTT waits');assert.equal(service.mqttMacroStatus?.pending,1);klippy.drop();await until(()=>service!.mqttMacroStatus?.cancelled===1);await service.reconnectKlippy();assert.equal(klippy.requests.filter(r=>r.method==='register_remote_method'&&r.params.remote_method==='publish_mqtt_topic').length,2);
  klippy.send('publish_mqtt_topic',{topic:'new',payload:true});await until(()=>service!.mqttMacroStatus?.completed===2&&peer.packets.some(p=>p.cmd==='publish'&&p.topic==='new'));assert.deepEqual(peer.packets.filter(p=>p.cmd==='publish').filter(p=>!p.topic.endsWith('/moonraker/status')).map(p=>p.topic),['printer/room','pending','new']);await service.close();assert.equal(service.mqttMacroStatus?.pending,0);
 }finally{await service?.close();await sensorTransport.close();sensors.close();await peer.close();await klippy.close();await rm(dir,{recursive:true,force:true});}
});
