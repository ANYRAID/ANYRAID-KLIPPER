import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {HistoryRepository} from '../src/moonraker/history-repository.ts';
import {SensorStore} from '../src/moonraker/sensors.ts';
import {mqttPeer} from './helpers/mqtt-peer.ts';
import {klippyMqttPeer} from './helpers/klippy-mqtt-peer.ts';
const information={connected:false,state:'disconnected' as const,components:['application'],failedComponents:[],directories:[],warnings:[],version:'configured-mqtt-test',missingRequirements:[]};
const sensor='[sensor room]\ntype: MQTT\nstate_topic: room/telemetry\nstate_response_template: {set_result("t", payload | float)}\n';
async function until(check:()=>boolean){const deadline=performance.now()+3000;while(!check()){assert(performance.now()<deadline,'Configured MQTT condition deadline');await new Promise(resolve=>setTimeout(resolve,5));}}
async function fixture(run:(root:string,file:string,peer:Awaited<ReturnType<typeof mqttPeer>>,config:(extra?:string,server?:string)=>Promise<void>)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'configured-mqtt-components-')),file=join(root,'moonraker.conf'),peer=await mqttPeer();
 const config=async(extra=sensor,server='host: 127.0.0.1\nport: 0')=>writeFile(file,`[server]\n${server}\n[mqtt]\naddress: 127.0.0.1\nport: ${peer.port}\ninstance_name: fixture\nusername: {secrets["mqtt"]["username"]}\npassword: {secrets["mqtt"]["password"]}\n${extra}`);
 try{await writeFile(join(root,'moonraker.secrets'),'{"mqtt":{"username":"fixture-user","password":"fixture-password"}}');await config();await run(root,file,peer,config);}finally{await peer.close();await rm(root,{recursive:true,force:true});}
}
test('standard configuration owns private MQTT, sensors, HTTP publication and complete closure',()=>fixture(async(root,file,peer)=>{
 const service=await ConfiguredMoonraker.load(file,{information,templates:{dataPath:root},authorize:(_method,_params,context)=>assert.equal(context.request.headers['x-api-key'],'fixture')});const owner=service.templates!;
 try{
  assert.equal(peer.packets.length,0);assert.equal(service.sensorTransportStatus?.started,false);const address=await service.start(),base=`http://127.0.0.1:${address.port}`;
  const connect=peer.packets.find(packet=>packet.cmd==='connect');assert(connect?.cmd==='connect');assert.equal(connect.username,'fixture-user');assert.equal(connect.password?.toString(),'fixture-password');
  peer.publish('room/telemetry','27.125');await until(()=>service.sensorTransportStatus?.messages===1);
  const info=await(await fetch(base+'/server/info',{headers:{'x-api-key':'fixture'}})).json() as any;for(const name of ['template','secrets','mqtt','sensor'])assert(info.result.components.includes(name));assert.equal(info.result.klippy_connected,false);
  const values=await(await fetch(base+'/server/sensors/info?sensor=room',{headers:{'x-api-key':'fixture'}})).json() as any;assert.equal(values.result.values.t,27.125);
  const settings=await(await fetch(base+'/server/config',{headers:{'x-api-key':'fixture'}})).text();for(const privateValue of ['fixture-user','fixture-password','secrets['])assert(!settings.includes(privateValue));
  assert.equal(owner.toJSON().templates,0);await service.close();assert.equal(owner.toJSON().closed,true);assert.equal(service.sensorStatus?.closed,true);assert.equal(service.sensorTransportStatus?.closed,true);assert.equal(service.rpc.has('server.mqtt.publish'),false);await until(()=>peer.sockets.size===0);
 }finally{await service.close();}
}));
test('MQTT without sensor bindings still owns presence and authenticated publish routes',()=>fixture(async(root,file,peer,config)=>{
 await config('');const service=await ConfiguredMoonraker.load(file,{information,authorize:()=>{},templates:{dataPath:root}});
 try{const address=await service.start(),base=`http://127.0.0.1:${address.port}`;assert.equal(service.sensorStatus?.sensors,0);assert.equal(service.sensorTransportStatus?.presence.online,true);
  const response=await fetch(base+'/server/mqtt/publish',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({topic:'fixture/output',payload:{value:2.675}})});assert.equal(response.status,200);await until(()=>peer.packets.some(packet=>packet.cmd==='publish'&&packet.topic==='fixture/output'));
  await service.close();assert(peer.packets.some(packet=>packet.cmd==='publish'&&packet.topic==='fixture/moonraker/status'&&packet.payload.toString()==='{"server":"offline"}'));
 }finally{await service.close();}
}));
for(const [name,extra] of [['unknown sensor','[sensor room]\ntype: HTTP\n'],['malformed template',sensor.replace('payload | float','{%')],['missing history owner',sensor+'history_field_temperature:\n  parameter=t\n  strategy=average\n'],['broker API without policy','enable_moonraker_api: true\n'],['invalid status interval','status_interval: .1\n']] as const)test(`automatic preparation rejects ${name} before broker access`,()=>fixture(async(root,file,peer,config)=>{
 await config(extra);await assert.rejects(ConfiguredMoonraker.load(file,{information,authorize:()=>{},templates:{dataPath:root}}));assert.equal(peer.packets.length,0);
 await config();const recovered=await ConfiguredMoonraker.load(file,{information,authorize:()=>{},templates:{dataPath:root}});assert.equal(recovered.templates?.toJSON().templates,0);await recovered.close();assert.equal(peer.packets.length,0);
}));
test('partial external sensor ownership is rejected without consuming the caller store',()=>fixture(async(root,file)=>{
 const sensors=new SensorStore();try{await assert.rejects(ConfiguredMoonraker.load(file,{information,authorize:()=>{},templates:{dataPath:root},sensors}),/Choose configured/);assert.equal(sensors.closed,false);}finally{sensors.close();}
}));
test('HTTP bind failure closes automatically created transport and private generation',()=>fixture(async(root,file,peer,config)=>{
 const blocker=createServer();blocker.listen(0,'127.0.0.1');await once(blocker,'listening');let service:ConfiguredMoonraker|undefined;
 try{await config(sensor,`host: 127.0.0.1\nport: ${(blocker.address() as any).port}`);service=await ConfiguredMoonraker.load(file,{information,authorize:()=>{},templates:{dataPath:root}});const owner=service.templates!;await assert.rejects(service.start(),/EADDRINUSE/);assert.equal(service.sensorTransportStatus?.closed,true);assert.equal(service.sensorStatus?.closed,true);assert.equal(owner.toJSON().closed,true);await until(()=>peer.sockets.size===0);}finally{await service?.close();await new Promise<void>(resolve=>blocker.close(()=>resolve()));}
}));
test('authorized standard loader assembles MQTT before user initialization and redacts credentials',()=>fixture(async(root,file,peer)=>{
 const database=await DatabaseStore.open({path:join(root,'users.db')});let service:ConfiguredMoonraker|undefined;
 try{service=await ConfiguredMoonraker.loadAuthorized(file,{information,database,authorization:{issuer:'http://fixture.test'},templates:{dataPath:root}});assert.equal(peer.packets.length,0);const owner=service.templates!;await service.start();assert.equal(service.sensorTransportStatus?.ready,true);assert.equal(service.reader.snapshot().original.mqtt.password,'<redacted>');await service.close();assert.equal(owner.toJSON().closed,true);assert.equal(database.status.closed,true);}finally{await service?.close();await database.close();}
}));
test('configured sensor fields follow actual history start, pause, resume and completion',()=>fixture(async(root,file,peer,config)=>{
 await config(sensor+'history_field_temperature:\n  parameter=t\n  strategy=accumulate\n  exclude_paused=true\n  report_total=true\n');const database=await DatabaseStore.open({path:join(root,'history.db')}),repository=await HistoryRepository.open(database),klippy=await klippyMqttPeer();let service:ConfiguredMoonraker|undefined;
 try{
  service=await ConfiguredMoonraker.load(file,{information,authorize:()=>{},templates:{dataPath:root},database,history:{repository,fileExists:async()=>true}});const address=await service.start();await service.attachKlippy(klippy.path);
  let duration=10;const state=async(state:string)=>{klippy.send('process_status_update',{eventtime:duration++,status:{print_stats:{state,filename:'part.gcode',total_duration:duration,print_duration:8,filament_used:2.675}}});await until(()=>service!.jobState?.stats.state===state);};
  const sample=async(value:number)=>{const messages=service!.sensorTransportStatus!.messages;peer.publish('room/telemetry',String(value));await until(()=>service!.sensorTransportStatus!.messages===messages+1);};
  await state('standby');await sample(100);await state('printing');await until(()=>service!.historyStatus?.currentJobId!==null);await sample(2);await state('paused');await sample(100);await state('printing');await sample(3);await state('complete');await until(()=>service!.historyStatus?.pending===0);
  const body=await(await fetch(`http://127.0.0.1:${address.port}/server/history/list`)).json() as any;assert.equal(body.result.jobs.length,1);assert.equal(body.result.jobs[0].status,'completed');assert.equal(body.result.jobs[0].auxiliary_data[0].value,5);
 }finally{await service?.close();await klippy.close();await database.close();}
}));
