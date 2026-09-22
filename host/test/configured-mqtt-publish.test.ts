import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WebSocket} from 'ws';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {MqttSensors} from '../src/moonraker/mqtt-sensors.ts';
import {SensorStore} from '../src/moonraker/sensors.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
import {mqttPeer} from './helpers/mqtt-peer.ts';
const information={connected:false,state:'disconnected' as const,components:['application'],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]};
async function fixture(ackPublishes:boolean,run:(service:ConfiguredMoonraker,url:string,peer:Awaited<ReturnType<typeof mqttPeer>>)=>Promise<void>){
 const directory=await mkdtemp(join(tmpdir(),'mqtt-publish-api-')),peer=await mqttPeer({ackPublishes}),sensors=new SensorStore(),sensorTransport=new MqttSensors({host:'127.0.0.1',port:peer.port},[]);let service:ConfiguredMoonraker|undefined;
 try{const path=join(directory,'main.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');service=await ConfiguredMoonraker.load(path,{sensors,sensorTransport,information,authorize:(_method,_params,context)=>{if(context.request.headers['x-api-key']!=='test')throw new ApiError(401,'Unauthorized');}});const address=await service.start();await run(service,`http://127.0.0.1:${address.port}`,peer);}
 finally{await service?.close();await sensorTransport.close();sensors.close();await peer.close();await rm(directory,{recursive:true,force:true});}
 if(service)assert.equal(service.rpc.has('server.mqtt.publish'),false);
}
const post=(url:string,body:unknown,authorized=true)=>fetch(url+'/server/mqtt/publish',{method:'POST',headers:{'content-type':'application/json',...(authorized?{'x-api-key':'test'}:{})},body:JSON.stringify(body)});
test('authorized HTTP and WebSocket publish reach MQTT with acknowledgment and are removed on close',()=>fixture(true,async(service,url,peer)=>{
 assert.equal((await post(url,{topic:'room',payload:'denied'},false)).status,401);assert.equal(peer.packets.filter(p=>p.cmd==='publish').length,0);
 const response=await post(url,{topic:'room',payload:{t:2.675},qos:1,retain:true});assert.equal(response.status,200);assert.deepEqual(await response.json(),{result:{topic:'room'}});
 const packet=peer.packets.find(p=>p.cmd==='publish');assert.ok(packet?.cmd==='publish');assert.deepEqual(JSON.parse(packet.payload.toString()),{t:2.675});assert.equal(packet.retain,true);
 const socket=new WebSocket(url.replace('http:','ws:')+'/websocket',{headers:{'x-api-key':'test'}});try{await once(socket,'open');const reply=once(socket,'message',{signal:AbortSignal.timeout(3000)});socket.send(JSON.stringify({jsonrpc:'2.0',id:2,method:'server.mqtt.publish',params:{topic:'room',payload:false,qos:2}}));assert.deepEqual(JSON.parse((await reply)[0].toString()),{jsonrpc:'2.0',result:{topic:'room'},id:2});assert.equal(peer.packets.filter(p=>p.cmd==='publish').at(-1)!.payload.toString(),'false');}finally{socket.terminate();}
 assert.equal((await post(url,{topic:'room/#',payload:'invalid'})).status,400);assert.equal((await post(url,{topic:'room',payload:'x'.repeat(65537)})).status,413);
}));
test('HTTP publish timeout reports uncertainty and a later request still succeeds',()=>fixture(false,async(_service,url,peer)=>{
 const response=await post(url,{topic:'room',payload:'unknown',qos:1,timeout:0.02});assert.equal(response.status,504);assert.match(JSON.stringify(await response.json()),/delivery may be unknown/);
 const recovery=await post(url,{topic:'room',payload:'next',qos:0});assert.equal(recovery.status,200);await recovery.json();assert.ok(peer.packets.some(p=>p.cmd==='publish'&&p.payload.toString()==='unknown'));
}));
