import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {PrintController,type PrintDevice} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
test('Configured native print routes authorize durable admission and responsive WebSocket status without a Klippy owner',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'configured-product-')),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'}),gate=new MaintenanceGate(),calls:string[]=[];let service:ConfiguredMoonraker|undefined;
 const target:PrintDevice={async prepare(_r,signal){calls.push('prepare');await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},async start(){calls.push('start');},async pause(){},async resume(){},async finish(){},async stop(){calls.push('stop');}};
 const controller=new PrintController(target,{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate});
 try{
  const path=join(dir,'main.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');service=await ConfiguredMoonraker.load(path,{productPrint:controller,maintenanceGate:gate,information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize:(_m,_p,ctx)=>{if(ctx.request.headers['x-api-key']!=='test')throw new ApiError(401,'Denied');return {username:'operator'};}});const address=await service.start(),url=`http://127.0.0.1:${address.port}`;
  assert.throws(()=>service!.attachKlippy(join(dir,'never.sock')),/native controller/);assert.throws(()=>service!.superviseKlippy(join(dir,'never.sock')),/native controller/);
  const params={version:1,request_id:'job',file_id:'sealed-file',nozzle:200,bed:60,expires_at:Date.now()+60000},post=(body:unknown,authorized=true)=>fetch(url+'/printer/print/start',{method:'POST',headers:{'content-type':'application/json',...authorized?{'x-api-key':'test'}:{}},body:JSON.stringify(body)});
  assert.equal((await fetch(url+'/printer/emergency_stop',{method:'POST'})).status,401);assert.equal(controller.state,'idle');assert.deepEqual(calls,[]);assert.equal((await post(params,false)).status,401);assert.equal(await journal.get('job'),null);const started=await post(params);assert.equal(started.status,200);assert.equal((await started.json()).result.accepted,true);assert.deepEqual(calls,['prepare']);
  const socket=new WebSocket(url.replace('http:','ws:')+'/websocket',{headers:{'x-api-key':'test'}});try{await once(socket,'open');const reply=once(socket,'message',{signal:AbortSignal.timeout(3000)});socket.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'printer.print.status'}));assert.equal(JSON.parse((await reply)[0].toString()).result.state,'preparing');}finally{socket.terminate();}
  assert.equal((await post(params)).status,200);assert.deepEqual(calls,['prepare']);await service.close();assert.deepEqual(calls,['prepare','stop','stop']);assert.equal((await journal.get('job'))?.state,'cancelled');
 }finally{await service?.close();await journal.close();await rm(dir,{recursive:true,force:true});}
});
test('MQTT native start uses durable request identity across transport timestamps and exposes request records',async()=>{
 const {mqttPeer}=await import('./helpers/mqtt-peer.ts'),{MqttSensors}=await import('../src/moonraker/mqtt-sensors.ts'),{SensorStore}=await import('../src/moonraker/sensors.ts');
 const peer=await mqttPeer(),dir=await mkdtemp(join(tmpdir(),'native-mqtt-')),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'}),gate=new MaintenanceGate(),sensors=new SensorStore(),sensorTransport=new MqttSensors({host:'127.0.0.1',port:peer.port,instanceName:'printer'},[]),calls:string[]=[];let service:ConfiguredMoonraker|undefined;
 const target:PrintDevice={async prepare(){calls.push('prepare');},async start(){calls.push('start');},async pause(){},async resume(){},async finish(){calls.push('finish');},async stop(){calls.push('stop');}},controller=new PrintController(target,{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate});
 const responses=()=>peer.packets.filter(p=>p.cmd==='publish').filter(p=>p.topic==='printer/moonraker/api/response');
 async function request(id:number,method:string,params:unknown){peer.publish('printer/moonraker/api/request',JSON.stringify({jsonrpc:'2.0',id,method,params}));const end=Date.now()+3000;while(!responses().some(p=>JSON.parse(p.payload.toString()).id===id)){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,5));}return JSON.parse(responses().find(p=>JSON.parse(p.payload.toString()).id===id)!.payload.toString());}
 try{
  const path=join(dir,'main.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');service=await ConfiguredMoonraker.load(path,{productPrint:controller,maintenanceGate:gate,sensors,sensorTransport,mqttAuthorize:()=>({username:'broker-operator'}),authorize:()=>{},information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]}});await service.start();
  const params={version:1,request_id:'job',file_id:'file',nozzle:200,bed:60,expires_at:Date.now()+60000};
  assert.equal((await request(1,'printer.print.start',{...params,mqtt_timestamp:1})).result.accepted,true);
  assert.equal((await request(2,'printer.print.start',{...params,mqtt_timestamp:2})).result.accepted,true);assert.deepEqual(calls,['prepare','start']);
  assert.equal((await request(3,'printer.print.cancel',{request_id:'old',state_token:controller.stateToken})).error.code,409);assert.deepEqual(calls,['prepare','start']);
  // MQTT admission confirms durable ownership, not completion of the start operation.
  await controller.start(controller.currentRequest!);assert.equal(controller.state,'printing');
  await controller.complete('job');await request(4,'printer.print.reset',{request_id:'job',state_token:controller.stateToken});const queried=await request(5,'printer.print.status',{request_id:'job'});assert.equal(queried.result.record.state,'completed');assert.equal(queried.result.current.state,'idle');assert.deepEqual(calls,['prepare','start','finish']);const stopped=await request(6,'printer.emergency_stop',{});assert.equal(stopped.result.current.state,'failed');assert.notEqual(stopped.result.current.state_token,queried.result.current.state_token);assert.equal((await request(7,'printer.print.start',{...params,request_id:'new'})).error.code,409);assert.deepEqual(calls,['prepare','start','finish','stop']);
 }finally{await service?.close();await sensorTransport.close();sensors.close();await journal.close();await peer.close();await rm(dir,{recursive:true,force:true});}
});
