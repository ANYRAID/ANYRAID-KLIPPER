import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {MqttSensors} from '../src/moonraker/mqtt-sensors.ts';
import {SensorStore} from '../src/moonraker/sensors.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
import {mqttPeer} from './helpers/mqtt-peer.ts';
const information={connected:false,state:'disconnected' as const,components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]};
async function until(check:()=>boolean){const end=Date.now()+3000;while(!check()){assert.ok(Date.now()<end,'MQTT RPC condition timed out');await new Promise(r=>setTimeout(r,5));}}
test('Configured MQTT routes authorized RPC and blocks retained/replayed commands across reconnect',async()=>{
 const peer=await mqttPeer(),dir=await mkdtemp(join(tmpdir(),'mqtt-rpc-')),sensors=new SensorStore(),sensorTransport=new MqttSensors({host:'127.0.0.1',port:peer.port,instanceName:'printer',reconnectMs:10},[]);let service:ConfiguredMoonraker|undefined,calls=0;
 try{
  const path=join(dir,'main.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0\n[mqtt]\nenable_moonraker_api=true\napi_qos=1');
  await assert.rejects(ConfiguredMoonraker.load(path,{sensors,sensorTransport,information,authorize:()=>{}}),/explicit broker authorization/);
  service=await ConfiguredMoonraker.load(path,{sensors,sensorTransport,information,authorize:()=>{throw new Error('HTTP policy must not authenticate MQTT');},mqttAuthorize:method=>{if(method!=='printer.counter')throw new ApiError(401,'Denied');return {username:'trusted-broker'};}});
  service.endpoints.register({endpoint:'/printer/counter',methods:['POST']},(params,_verb,ctx)=>{assert.equal(ctx.user?.username,'trusted-broker');assert.equal(params.mqtt_timestamp,undefined);return ++calls;});await service.start();
  assert.ok(peer.subscriptions.some(s=>s.topic==='printer/moonraker/api/request'&&s.qos===1));const responses=()=>peer.packets.filter(p=>p.cmd==='publish').filter(p=>p.topic==='printer/moonraker/api/response');
  const request=JSON.stringify({jsonrpc:'2.0',id:1,method:'printer.counter',params:{mqtt_timestamp:123}});
  peer.send({cmd:'publish',topic:'printer/moonraker/api/request',payload:request,qos:0,retain:true,dup:false});await until(()=>service!.mqttRpcStatus!.rejected===1);assert.equal(calls,0);
  peer.publish('printer/moonraker/api/request',request);await until(()=>responses().length===1);assert.equal(JSON.parse(responses()[0].payload.toString()).result,1);assert.equal(responses()[0].qos,1);
  peer.drop();await until(()=>sensorTransport.status.connections===2&&sensorTransport.status.ready);peer.publish('printer/moonraker/api/request',request);await until(()=>responses().length===2);assert.equal(JSON.parse(responses()[1].payload.toString()).error.code,-10000);assert.equal(calls,1);
  peer.publish('printer/moonraker/api/request',JSON.stringify({jsonrpc:'2.0',id:2,method:'server.info'}));await until(()=>responses().length===3);assert.equal(JSON.parse(responses()[2].payload.toString()).error.code,-32602);assert.equal(service.mqttRpcStatus!.failed,0);
 }finally{await service?.close();await sensorTransport.close();sensors.close();await peer.close();await rm(dir,{recursive:true,force:true});}
});
test('Configured MQTT refuses a transport with an existing RPC owner without consuming its sensor store',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mqtt-rpc-owner-')),sensors=new SensorStore(),bound=new MqttSensors({host:'127.0.0.1'},[]),fresh=new MqttSensors({host:'127.0.0.1'},[]);let service:ConfiguredMoonraker|undefined;
 try{const path=join(dir,'main.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');bound.bindRpc(()=>{},0);
  await assert.rejects(ConfiguredMoonraker.load(path,{sensors,sensorTransport:bound,information,authorize:()=>{}}),/already owned sensor transport/);
  service=await ConfiguredMoonraker.load(path,{sensors,sensorTransport:fresh,information,authorize:()=>{}});assert.equal(fresh.status.started,false);
 }finally{await service?.close();await bound.close();await fresh.close();sensors.close();await rm(dir,{recursive:true,force:true});}
});
