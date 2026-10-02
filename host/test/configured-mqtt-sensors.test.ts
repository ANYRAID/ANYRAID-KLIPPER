import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {WebSocket} from 'ws';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {MqttSensors} from '../src/moonraker/mqtt-sensors.ts';
import {SensorStore} from '../src/moonraker/sensors.ts';
import {SensorMessages} from '../src/moonraker/sensor-messages.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
import {mqttPeer} from './helpers/mqtt-peer.ts';
const information={connected:false,state:'disconnected' as const,components:['application'],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]};
const authorize=(_method:unknown,_params:unknown,context:any)=>{if(context.request.headers['x-api-key']!=='test')throw new ApiError(401,'Unauthorized');};
async function fixture(run:(path:string)=>Promise<void>){const directory=await mkdtemp(join(tmpdir(),'configured-mqtt-'));try{const path=join(directory,'main.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');await run(path);}finally{await rm(directory,{recursive:true,force:true});}}
function source(port:number,timeoutMs=1000){const sensors=new SensorStore();sensors.register({id:'room',type:'MQTT'});const receiver=new SensorMessages(sensors,'room',context=>context.setResult('t',context.payload)),sensorTransport=new MqttSensors({host:'127.0.0.1',port,timeoutMs},[{topic:'room',receiver}]);return {sensors,sensorTransport,receiver};}
test('server owns real MQTT startup and forwards received values to HTTP and authorized WebSocket',()=>fixture(async path=>{
 const peer=await mqttPeer(),resources=source(peer.port),service=await ConfiguredMoonraker.load(path,{authorize,authorizeNotification:authorize,information,...resources});let socket:WebSocket|undefined;
 try{
  assert.equal(peer.packets.length,0);assert.equal(service.sensorTransportStatus?.started,false);await assert.rejects(ConfiguredMoonraker.load(path,{authorize,information,...resources}),/already owned/);
  const address=await service.start(),url=`http://127.0.0.1:${address.port}`;assert.equal(service.sensorTransportStatus?.ready,true);socket=new WebSocket(url.replace('http:','ws:')+'/websocket',{headers:{'x-api-key':'test'}});await once(socket,'open');const notification=once(socket,'message',{signal:AbortSignal.timeout(4000)});peer.publish('room','27.125');assert.deepEqual(JSON.parse((await notification)[0].toString()),{jsonrpc:'2.0',method:'notify_sensor_update',params:[{room:{t:27.125}}]});
  assert.equal((await fetch(url+'/server/sensors/info?sensor=room')).status,401);const body:any=await(await fetch(url+'/server/sensors/info?sensor=room',{headers:{'x-api-key':'test'}})).json();assert.equal(body.result.values.t,27.125);
 }finally{socket?.terminate();await service.close();await peer.close();}
 assert.equal(resources.receiver.status.closed,true);assert.equal(resources.sensors.closed,true);assert.equal(service.sensorTransportStatus?.closed,true);assert.equal(service.rpc.has('server.sensors.info'),false);
}));
test('MQTT subscription failure and subsequent HTTP bind failure clean every transferred owner',()=>fixture(async path=>{
 const denied=await mqttPeer({reject:true}),first=source(denied.port,80),service=await ConfiguredMoonraker.load(path,{authorize,information,...first});try{await assert.rejects(service.start(),/timed out/);assert.equal(service.status.phase,'closed');assert.equal(first.sensors.closed,true);assert.equal(first.sensorTransport.status.closed,true);}finally{await service.close();await denied.close();}
 const blocker=createServer();blocker.listen(0,'127.0.0.1');await once(blocker,'listening');await writeFile(path,`[server]\nhost=127.0.0.1\nport=${(blocker.address() as any).port}`);const peer=await mqttPeer(),second=source(peer.port),failed=await ConfiguredMoonraker.load(path,{authorize,information,...second});try{await assert.rejects(failed.start(),/EADDRINUSE/);assert.equal(second.sensorTransport.status.closed,true);assert.equal(second.sensors.closed,true);assert.equal(peer.subscriptions.length,1);}finally{await failed.close();await peer.close();await new Promise<void>(r=>blocker.close(()=>r()));}
}));
test('startup cancellation and mismatched store ownership never leave a live MQTT connection',()=>fixture(async path=>{
 const peer=await mqttPeer(),resources=source(peer.port),unrelated=new SensorStore();try{await assert.rejects(ConfiguredMoonraker.load(path,{authorize,information,sensors:unrelated,sensorTransport:resources.sensorTransport}),/transport/);assert.equal(resources.sensorTransport.status.closed,false);
  const service=await ConfiguredMoonraker.load(path,{authorize,information,...resources});const rejected=assert.rejects(service.start(),/closed|stopping|cancelled/);await service.close();await rejected;assert.equal(service.status.phase,'closed');assert.equal(resources.sensorTransport.status.closed,true);
 }finally{await resources.sensorTransport.close();await peer.close();unrelated.close();resources.sensors.close();}
}));
