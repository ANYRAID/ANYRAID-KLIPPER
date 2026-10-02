/** Explicit candidate integration: node --test host/bench/native-sensor-integration.ts */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WebSocket} from 'ws';
import {configureNativeSensors,configureNativeSensorsFromConfig,NativeSensorMessages} from '../src/moonraker/native-sensor-config.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource,loadConfiguration} from '../src/moonraker/config-source.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {SensorStore} from '../src/moonraker/sensors.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
import {mqttPeer} from '../test/helpers/mqtt-peer.ts';
const information={connected:false,state:'disconnected' as const,components:['application'],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]};
const authorize=(_method:unknown,_params:unknown,context:any)=>{if(context.request.headers['x-api-key']!=='test')throw new ApiError(401,'Unauthorized');};
const source='{% set d=payload|fromjson %}{set_result("t",d.t|round(2))}';
async function waitFor(check:()=>boolean){const deadline=Date.now()+4000;while(!check()){assert.ok(Date.now()<deadline,'condition timed out');await new Promise(r=>setTimeout(r,5));}}
test('configured native template carries MQTT values through authorized HTTP and WebSocket with atomic failure recovery',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'native-sensor-')),peer=await mqttPeer();
 let resources:ReturnType<typeof configureNativeSensors>|undefined,service:ConfiguredMoonraker|undefined,socket:WebSocket|undefined;
 try{
  const path=join(directory,'main.conf');await writeFile(path,`[server]\nhost=127.0.0.1\nport=0\n[sensor room]\ntype=MQTT\nstate_topic=room\nstate_response_template=${source}\nhistory_field_t=parameter=t\n  strategy=basic\n  precision=2\n  init_tracker=true\n`);
  const {appendFile}=await import('node:fs/promises');await appendFile(path,`\n[mqtt]\naddress=127.0.0.1\nport=${peer.port}\nusername=test-user\npassword=test-password\ndefault_qos=2\nclient_id=sensor-test\n`);
  const reader=new ConfigurationReader(await loadConfiguration(path));resources=await configureNativeSensorsFromConfig(reader,()=>true);
  assert.equal(resources.sensorTransport.status.started,false);assert.equal(peer.packets.length,0);
  service=await ConfiguredMoonraker.load(path,{authorize,authorizeNotification:authorize,information,sensors:resources.sensors,sensorTransport:resources.sensorTransport});
  const address=await service.start(),url=`http://127.0.0.1:${address.port}`;
  const connect=peer.packets.find(p=>p.cmd==='connect');assert.equal(connect?.cmd,'connect');if(connect?.cmd==='connect'){assert.equal(connect.clientId,'sensor-test');assert.equal(connect.username,'test-user');assert.equal(connect.password?.toString(),'test-password');}assert.equal(peer.subscriptions[0].qos,2);
  socket=new WebSocket(url.replace('http:','ws:')+'/websocket',{headers:{'x-api-key':'test'}});await once(socket,'open');
  const notification=once(socket,'message',{signal:AbortSignal.timeout(4000)});peer.publish('room','{"t":2.675}');
  assert.deepEqual(JSON.parse((await notification)[0].toString()),{jsonrpc:'2.0',method:'notify_sensor_update',params:[{room:{t:2.67}}]});
  assert.equal((await fetch(url+'/server/sensors/info?sensor=room')).status,401);
  const body:any=await(await fetch(url+'/server/sensors/info?sensor=room',{headers:{'x-api-key':'test'}})).json();assert.equal(body.result.values.t,2.67);
  assert.equal((resources.fields.snapshot().data[0] as {value:number}).value,2.67);
  peer.publish('room','{"t":9007199254740993}');await waitFor(()=>resources!.receivers[0].status.rejected===1);assert.equal(resources.sensors.info('room').values.t,2.67);
  peer.publish('room','{"t":1.0}');await waitFor(()=>resources!.receivers[0].status.accepted===2);assert.equal(resources.sensors.info('room').values.t,1);
  peer.drop();await waitFor(()=>resources!.sensorTransport.status.connections===2&&resources!.sensorTransport.status.ready);assert.deepEqual(resources.sensors.info('room').values,{});
  peer.publish('room','{"t":-2.675}');await waitFor(()=>resources!.receivers[0].status.accepted===3);assert.equal(resources.sensors.info('room').values.t,-2.67);
  await service.close();assert.equal(resources.receivers[0].status.closed,true);assert.equal(resources.sensors.closed,true);assert.equal(resources.receivers[0].receive(Buffer.from('{"t":3}')),false);await resources.close();
 }finally{socket?.terminate();await service?.close();await resources?.close();await peer.close();await rm(directory,{recursive:true,force:true});}
});
test('native source assembly rejects syntax before opening MQTT and closes on subscription failure',async()=>{
 const options={type:'MQTT',state_topic:'room',state_response_template:source};
 const reader=(extra:Record<string,string>)=>new ConfigurationReader(new ConfigurationSource('/config/main.conf',{DEFAULT:{},server:{},'sensor first':options,'sensor second':{...options,...extra}},[]));
 const bad=reader({state_response_template:'{% if %}'});assert.throws(()=>configureNativeSensors(bad,()=>true,{host:'127.0.0.1'}),/Invalid sensor template/);assert.equal(bad.parsed()['sensor second'].__CONFIG_ERROR__,true);
 assert.throws(()=>configureNativeSensors(reader({}),()=>true,{host:''}),/Invalid MQTT/);
 const store=new SensorStore();assert.throws(()=>new NativeSensorMessages(store,'missing',source));store.close();
 const peer=await mqttPeer({reject:true}),resources=configureNativeSensors(reader({}),()=>true,{host:'127.0.0.1',port:peer.port,timeoutMs:80});
 try{await assert.rejects(resources.sensorTransport.start(),/timed out/);await resources.close();assert.ok(resources.receivers.every(r=>r.status.closed));assert.equal(resources.sensors.closed,true);}finally{await resources.close();await peer.close();}
});
