import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {MqttSensors} from '../src/moonraker/mqtt-sensors.ts';
import {SensorStore} from '../src/moonraker/sensors.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
import {mqttPeer} from '../test/helpers/mqtt-peer.ts';
const directory=await mkdtemp(join(tmpdir(),'mqtt-api-bench-')),peer=await mqttPeer(),sensors=new SensorStore(),sensorTransport=new MqttSensors({host:'127.0.0.1',port:peer.port},[]);let service:ConfiguredMoonraker|undefined;
try{
 const path=join(directory,'main.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');service=await ConfiguredMoonraker.load(path,{sensors,sensorTransport,information:{connected:false,state:'disconnected',components:['application'],failedComponents:[],directories:[],warnings:[],version:'bench',missingRequirements:[]},authorize:(_m,_p,context)=>{if(context.request.headers['x-api-key']!=='bench')throw new ApiError(401,'Unauthorized');}});
 const address=await service.start(),url=`http://127.0.0.1:${address.port}/server/mqtt/subscribe`,times=[];
 for(let run=0;run<9;run++){const start=performance.now();for(let i=0;i<50;i++){
  const response=fetch(url,{method:'POST',headers:{'content-type':'application/json','x-api-key':'bench'},body:JSON.stringify({topic:'room',qos:0})});
  const deadline=Date.now()+3000;while(peer.subscriptions.length<run*50+i+1){assert.ok(Date.now()<deadline);await new Promise<void>(r=>setImmediate(r));}
  peer.publish('room',JSON.stringify({t:2.675,index:i}));const result=await response;assert.equal(result.status,200);assert.deepEqual(await result.json(),{result:{topic:'room',payload:{t:2.675,index:i}}});
 }if(run>=2)times.push(performance.now()-start);}
 assert.equal(peer.subscriptions.length,450);assert.equal(service.sensorTransportStatus?.waiting,0);times.sort((a,b)=>a-b);
 console.log(JSON.stringify({node:process.version,requests:50,warmup:2,samples:7,medianMs:times[3],p95Ms:times[6],scope:'Sequential authorized HTTP subscribe, real MQTT SUBSCRIBE/message/UNSUBSCRIBE and JSON response checks; no Python service baseline, TLS or printing'},null,2));
}finally{await service?.close();await sensorTransport.close();sensors.close();await peer.close();await rm(directory,{recursive:true,force:true});}
