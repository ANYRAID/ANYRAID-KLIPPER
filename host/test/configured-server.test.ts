import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WebSocket} from 'ws';
import {ConfiguredMoonraker,readNetworkBinding} from '../src/moonraker/configured-server.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
import type {InformationSnapshot} from '../src/moonraker/metadata.ts';
const info=():InformationSnapshot=>({connected:false,state:'disconnected',components:['application'],failedComponents:[],directories:[],warnings:[],version:'node-test',missingRequirements:[]});
const authorize=(_m:unknown,_p:unknown,c:any)=>{if(c.request.headers['x-api-key']!=='test')throw new ApiError(401,'Unauthorized');};
async function fixture(text:string,run:(path:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'configured-server-test-'));try{const path=join(dir,'main.conf');await writeFile(path,text);await run(path);}finally{await rm(dir,{recursive:true,force:true});}}
test('network binding reads upstream defaults and rejects invalid or imprecise settings',()=>{
 const make=(server:Record<string,string>)=>new ConfigurationReader(new ConfigurationSource('/config/main.conf',{DEFAULT:{},server},[]));
 assert.deepEqual(readNetworkBinding(make({})),{host:'0.0.0.0',port:7125,maxConnections:50});
 for(const server of [{port:'-1'},{port:'65536'},{port:'9007199254740993'},{port:'1.5'},{host:' '},{host:'http://localhost'},{max_websocket_connections:'0'},{max_websocket_connections:'10001'}] as Record<string,string>[])assert.throws(()=>readNetworkBinding(make(server)));
});
test('file-backed startup binds settings, metadata, authorization and actual WebSocket capacity',()=>fixture('[server]\nhost=127.0.0.1\nport=0\nmax_websocket_connections=1\n[consumer]\nspeed=120.5',async path=>{
 const service=await ConfiguredMoonraker.load(path,{authorize,information:info()});let ws:WebSocket|undefined;
 try{
  service.reader.section('consumer').getFloat('speed',{above:0});assert.equal(service.status.phase,'new');const opening=service.start();assert.equal(service.start(),opening);const address=await opening;assert.equal(address.address,'127.0.0.1');assert.ok(address.port>0);
  await rm(path);const url=`http://127.0.0.1:${address.port}`;assert.equal((await fetch(url+'/server/config')).status,401);
  let body:any=await (await fetch(url+'/server/config',{headers:{'x-api-key':'test'}})).json();assert.deepEqual(body.result.config,{server:{host:'127.0.0.1',port:0,max_websocket_connections:1},consumer:{speed:120.5}});assert.equal(body.result.orig.consumer.speed,'120.5');
  ws=new WebSocket(url.replace('http:','ws:')+'/websocket',{headers:{'x-api-key':'test'}});await once(ws,'open');const extra=new WebSocket(url.replace('http:','ws:')+'/websocket');await assert.rejects(once(extra,'open'),/503/);extra.terminate();
  body=await (await fetch(url+'/server/info',{headers:{'x-api-key':'test'}})).json();assert.equal(body.result.websocket_count,1);assert.equal(body.result.klippy_state,'disconnected');assert(!body.result.components.includes('history'),'unregistered history cannot be advertised');
  service.setInformation({...info(),connected:true,state:'shutdown'});body=await (await fetch(url+'/server/info',{headers:{'x-api-key':'test'}})).json();assert.equal(body.result.klippy_state,'shutdown');
 }finally{ws?.terminate();await service.close();}
 assert.equal(service.rpc.has('server.config'),false);assert.equal(service.rpc.has('server.websocket.id'),false);await service.close();await assert.rejects(service.start(),/stopping/);
}));
test('unused configuration warnings retain names without revealing values and survive lifecycle updates',()=>fixture('[server]\nhost=127.0.0.1\nport=0\nsecret=do-not-log\n[unknown]\npassword=private',async path=>{
 const service=await ConfiguredMoonraker.load(path,{authorize,information:info()});try{const address=await service.start();for(const state of ['disconnected','ready'] as const){service.setInformation({...info(),connected:state==='ready',state});const body:any=await(await fetch(`http://127.0.0.1:${address.port}/server/info`,{headers:{'x-api-key':'test'}})).json();assert.equal(body.result.warnings.length,2);assert.match(body.result.warnings.join(),/secret/);assert.equal(body.result.warnings.join().includes('do-not-log'),false);}}finally{await service.close();}
}));
test('occupied port failure closes owned resources and unregisters metadata',()=>fixture('[server]\nhost=127.0.0.1\nport=0',async path=>{
 const blocker=createServer();blocker.listen(0,'127.0.0.1');await once(blocker,'listening');const port=(blocker.address() as any).port;await writeFile(path,`[server]\nhost=127.0.0.1\nport=${port}`);
 const service=await ConfiguredMoonraker.load(path,{authorize,information:info()});try{await assert.rejects(service.start(),/EADDRINUSE/);assert.equal(service.status.phase,'closed');assert.equal(service.rpc.has('server.info'),false);await service.close();}finally{await new Promise<void>(resolve=>blocker.close(()=>resolve()));}
}));
test('startup and shutdown race does not leak a listener or claim startup success',()=>fixture('[server]\nhost=127.0.0.1\nport=0',async path=>{
 const service=await ConfiguredMoonraker.load(path,{authorize,information:info()});const opening=service.start(),rejected=assert.rejects(opening,/cancelled/);await service.close();await rejected;assert.equal(service.status.phase,'closed');assert.equal(service.status.connections,0);assert.equal(service.rpc.has('server.config'),false);
}));
test('configuration errors and missing authorization reject before a listener is constructed',()=>fixture('[server]\nport=not-a-number',async path=>{
 await assert.rejects(ConfiguredMoonraker.load(path,{authorize,information:info()}));await assert.rejects(ConfiguredMoonraker.load(path,{information:info()} as any),/authorization/);
}));
test('failed shutdown retains owned registrations until active requests actually settle',()=>fixture('[server]\nhost=127.0.0.1\nport=0',async path=>{
 const service=await ConfiguredMoonraker.load(path,{authorize,information:info(),shutdownTimeoutMs:20});let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>release=r);
 service.rpc.register('server.slow',['http'],async()=>{entered();await blocked;return null;});
 try{const address=await service.start(),pending=fetch(`http://127.0.0.1:${address.port}/server/jsonrpc`,{method:'POST',headers:{'content-type':'application/json','x-api-key':'test'},body:JSON.stringify({jsonrpc:'2.0',method:'server.slow',id:1})}).catch(()=>null);await started;await assert.rejects(service.close(),/shutdown deadline/);assert.equal(service.status.phase,'closing');assert.equal(service.rpc.has('server.config'),true);release();await pending;await service.close();assert.equal(service.rpc.has('server.config'),false);assert.equal(service.status.phase,'closed');}finally{release?.();await service.close();}
}));
test('invalid configured Klippy path fails load before network startup',()=>fixture('[server]\nhost=127.0.0.1\nport=0\nklippy_uds_address={data_path}/klippy.sock',async path=>{
 await assert.rejects(ConfiguredMoonraker.load(path,{authorize,information:info(),klippy:{}}),/renderer/);await assert.rejects(ConfiguredMoonraker.load(path,{authorize,information:info(),klippy:{retryDelayMs:0}}),/retry/);
}));
test('server seals component table registration before exposing its listener',()=>fixture('[server]\nhost=127.0.0.1\nport=0',async path=>{
 const {DatabaseStore}=await import('../src/moonraker/database.ts'),store=await DatabaseStore.open({path:join(path,'..','tables.sqlite')}),service=await ConfiguredMoonraker.load(path,{authorize,information:info(),database:store});
 try{await store.registerTable({name:'component_table',prototype:'component_table (id INTEGER PRIMARY KEY)',version:1});await service.start();await assert.rejects(store.registerTable({name:'late_table',prototype:'late_table (id INT)',version:1}),e=>e instanceof ApiError&&e.status===409);await store.insert('ui','still_writable',true);assert.equal(await store.get('ui','still_writable'),true);}finally{await service.close();}
}));
test('owned sensors sample after listening, publish changes and close with the server',()=>fixture('[server]\nhost=127.0.0.1\nport=0',async path=>{
 const {SensorStore}=await import('../src/moonraker/sensors.ts');const sensors=new SensorStore();sensors.register({id:'room',type:'MQTT',capacity:2});sensors.update('room',{t:{value:22.5}});
 const service=await ConfiguredMoonraker.load(path,{authorize,information:info(),sensors,authorizeNotification:authorize});let ws:WebSocket|undefined;
 try{
  assert.equal(service.sensorStatus?.samples,0);assert.deepEqual(sensors.measurements(),{room:{}});
  await assert.rejects(ConfiguredMoonraker.load(path,{authorize,information:info(),sensors}),/already owned/);
  const address=await service.start(),url=`http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(url+'/server/sensors/list')).status,401);
  ws=new WebSocket(url.replace('http:','ws:')+'/websocket',{headers:{'x-api-key':'test'}});await once(ws,'open');
  const [message]=await once(ws,'message',{signal:AbortSignal.timeout(4000)});assert.deepEqual(JSON.parse(message.toString()),{jsonrpc:'2.0',method:'notify_sensor_update',params:[{room:{t:22.5}}]});
  let body:any=await(await fetch(url+'/server/sensors/measurements?sensor=room',{headers:{'x-api-key':'test'}})).json();assert.deepEqual(body.result,{room:{t:[22.5]}});
  const messages:any[]=[];ws.on('message',data=>messages.push(JSON.parse(data.toString())));
  const initial=service.sensorStatus!.samples,deadline=Date.now()+4000;while(service.sensorStatus!.samples===initial&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
  assert.ok(service.sensorStatus!.samples>initial);assert.equal(messages.length,0);assert.deepEqual(sensors.measurements(),{room:{t:[22.5,22.5]}});
  const changed=once(ws,'message',{signal:AbortSignal.timeout(4000)});sensors.disconnect('room');assert.deepEqual(JSON.parse((await changed)[0].toString()).params,[{room:{}}]);
 }finally{ws?.terminate();await service.close();}
 assert.equal(sensors.status.closed,true);assert.equal(service.rpc.has('server.sensors.list'),false);assert.throws(()=>sensors.update('room',{t:{value:0}}),/closed/);
 const count=service.sensorStatus!.samples;await new Promise(r=>setTimeout(r,1100));assert.equal(service.sensorStatus!.samples,count);
}));
test('failed network startup closes transferred sensor store and releases query routes',()=>fixture('[server]\nhost=127.0.0.1\nport=0',async path=>{
 const {SensorStore}=await import('../src/moonraker/sensors.ts');const sensors=new SensorStore(),blocker=createServer();blocker.listen(0,'127.0.0.1');await once(blocker,'listening');await writeFile(path,`[server]\nhost=127.0.0.1\nport=${(blocker.address() as any).port}`);
 const service=await ConfiguredMoonraker.load(path,{authorize,information:info(),sensors});
 try{await assert.rejects(service.start(),/EADDRINUSE/);assert.equal(sensors.status.closed,true);assert.equal(service.sensorStatus?.samples,0);assert.equal(service.rpc.has('server.sensors.info'),false);}finally{await service.close();await new Promise<void>(r=>blocker.close(()=>r()));}
}));
test('sensor sampling failure stops the timer and exposes component failure without leaking details',()=>fixture('[server]\nhost=127.0.0.1\nport=0',async path=>{
 const {SensorStore}=await import('../src/moonraker/sensors.ts');const sensors=new SensorStore();let calls=0;sensors.sample=()=>{calls++;throw new Error('private-source-detail');};
 const service=await ConfiguredMoonraker.load(path,{authorize,information:info(),sensors});
 try{
  const address=await service.start(),deadline=Date.now()+4000;while(!service.sensorStatus?.error&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
  assert.equal(service.sensorStatus?.error,'private-source-detail');const body:any=await(await fetch(`http://127.0.0.1:${address.port}/server/info`,{headers:{'x-api-key':'test'}})).json();assert.ok(body.result.failed_components.includes('sensor'));assert.ok(body.result.warnings.includes('Sensor sampling failed; restart required'));assert.equal(JSON.stringify(body).includes('private-source-detail'),false);
  await new Promise(r=>setTimeout(r,1100));assert.equal(calls,1);
 }finally{await service.close();}
}));
test('network changes use real authorized WebSocket dispatch while system queries stay cached', {timeout:20000},()=>fixture('[server]\nhost=127.0.0.1\nport=0',async path=>{
 let samples=0;const events:any[]=[];const source=async()=>({runtime:{name:'node'},network:{eth0:{mac_address:'02:00:00:00:00:01',ip_addresses:[{family:'ipv4',address:++samples===1?'192.0.2.1':'192.0.2.2',is_link_local:false}]}},canbus:{}});
 const service=await ConfiguredMoonraker.load(path,{authorize,information:info(),systemInformation:{source},authorizeNotification:(_method,_params,context)=>{if(context.request.headers['x-observer']!=='allowed')throw new ApiError(403,'Observation denied');}});
 const sockets:WebSocket[]=[];
 try{
  const address=await service.start(),url=`http://127.0.0.1:${address.port}`,headers={'x-api-key':'test'};
  assert.equal(samples,1);assert.equal((await fetch(url+'/machine/system_info')).status,401);
  for(const role of ['allowed','denied']){const ws=new WebSocket(url.replace('http:','ws:')+'/websocket',{headers:{...headers,'x-observer':role}});sockets.push(ws);ws.on('message',data=>events.push({role,...JSON.parse(data.toString())}));await once(ws,'open');}
  const first:any=await(await fetch(url+'/machine/system_info',{headers})).json();assert.equal(first.result.system_info.network.eth0.ip_addresses[0].address,'192.0.2.1');
  const rpc:any=await(await fetch(url+'/server/jsonrpc',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'machine.system_info'})})).json();assert.deepEqual(rpc.result,first.result);assert.equal(samples,1);assert.equal(events.length,0);
  const changed=await once(sockets[0],'message',{signal:AbortSignal.timeout(14000)});assert.deepEqual(JSON.parse(changed[0].toString()),{jsonrpc:'2.0',method:'notify_net_state_changed',params:[{eth0:{mac_address:'02:00:00:00:00:01',ip_addresses:[{family:'ipv4',address:'192.0.2.2',is_link_local:false}]}}]});
  const deadline=Date.now()+1000;while(service.systemNotificationMetrics.denied<1&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
  assert.equal(samples,2);assert.equal(events.length,1);assert.equal(events[0].role,'allowed');assert.equal(service.systemNotificationMetrics.sent,1);assert.equal(service.systemNotificationMetrics.denied,1);
  const second:any=await(await fetch(url+'/machine/system_info',{headers})).json();assert.deepEqual(second.result.system_info.network,events[0].params[0]);assert.equal(samples,2);
 }finally{for(const socket of sockets)socket.terminate();await service.close();}
 assert.equal(service.systemInformationStatus?.closed,true);assert.equal(service.systemInformationStatus?.pending,false);assert.equal(service.rpc.has('machine.system_info'),false);
}));
