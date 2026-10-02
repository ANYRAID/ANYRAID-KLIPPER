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
 if(service)assert.equal(service.rpc.has('server.mqtt.subscribe'),false);
}
async function until(check:()=>boolean){const deadline=Date.now()+3000;while(!check()){assert.ok(Date.now()<deadline,'subscription condition timed out');await new Promise(r=>setTimeout(r,5));}}
const post=(url:string,body:unknown,authorized=true,signal?:AbortSignal)=>fetch(url+'/server/mqtt/subscribe',{method:'POST',headers:{'content-type':'application/json',...(authorized?{'x-api-key':'test'}:{})},body:JSON.stringify(body),signal});
test('authorized HTTP and WebSocket subscriptions return JSON/text and remove broker subscriptions',()=>fixture(true,async(service,url,peer)=>{
 assert.equal((await post(url,{topic:'room'},false)).status,401);assert.equal(peer.subscriptions.length,0);
 const pending=post(url,{topic:'room',qos:1});await until(()=>peer.subscriptions.length===1);peer.publish('room','{"t":2.675}',1);const response=await pending;assert.equal(response.status,200);assert.deepEqual(await response.json(),{result:{topic:'room',payload:{t:2.675}}});await until(()=>peer.packets.some(p=>p.cmd==='unsubscribe'));
 const socket=new WebSocket(url.replace('http:','ws:')+'/websocket',{headers:{'x-api-key':'test'}});
 try{await once(socket,'open');const reply=once(socket,'message',{signal:AbortSignal.timeout(3000)});socket.send(JSON.stringify({jsonrpc:'2.0',id:7,method:'server.mqtt.subscribe',params:{topic:'text',qos:2}}));await until(()=>peer.subscriptions.length===2);peer.publish('text','plain text',2);assert.deepEqual(JSON.parse((await reply)[0].toString()),{jsonrpc:'2.0',result:{topic:'text',payload:'plain text'},id:7});}
 finally{socket.terminate();}
 assert.equal(service.sensorTransportStatus?.waiting,0);
}));
test('HTTP cancellation and WebSocket disconnect release pending MQTT subscriptions',()=>fixture(true,async(service,url,peer)=>{
 const abort=new AbortController(),cancelled=assert.rejects(post(url,{topic:'cancelled'},true,abort.signal));await until(()=>peer.subscriptions.length===1);abort.abort();await cancelled;await until(()=>service.sensorTransportStatus?.waiting===0);await until(()=>peer.packets.some(p=>p.cmd==='unsubscribe'));
 const socket=new WebSocket(url.replace('http:','ws:')+'/websocket',{headers:{'x-api-key':'test'}});try{await once(socket,'open');socket.send(JSON.stringify({jsonrpc:'2.0',id:8,method:'server.mqtt.subscribe',params:{topic:'gone'}}));await until(()=>service.sensorTransportStatus?.waiting===1);socket.terminate();await until(()=>service.sensorTransportStatus?.waiting===0);await until(()=>peer.packets.filter(p=>p.cmd==='unsubscribe').length===2);}finally{socket.terminate();}
}));
test('subscription timeout and unsafe JSON return errors while later requests recover',()=>fixture(true,async(service,url,peer)=>{
 assert.equal((await post(url,{topic:'timeout',timeout:0.02})).status,504);
 const unsafe=post(url,{topic:'unsafe'});await until(()=>peer.subscriptions.some(s=>s.topic==='unsafe'));peer.publish('unsafe','{"n":9007199254740993}');assert.equal((await unsafe).status,422);
 const recovery=post(url,{topic:'recovery'});await until(()=>peer.subscriptions.some(s=>s.topic==='recovery'));peer.publish('recovery','"9007199254740993"');assert.deepEqual(await(await recovery).json(),{result:{topic:'recovery',payload:'9007199254740993'}});assert.equal(service.sensorTransportStatus?.waiting,0);
}));
