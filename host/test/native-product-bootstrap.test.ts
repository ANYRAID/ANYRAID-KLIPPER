import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {request} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {createNativeProductHostFactory} from '../src/runtime/native-product-machine.ts';
import {runProductHost} from '../src/runtime/product-host.ts';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
import {productMachineFixture} from './helpers/product-machine.ts';
async function until(check:()=>boolean){const end=performance.now()+10000;while(!check()){assert(performance.now()<end,'Bootstrap timeout');await delay(5);}}
async function fixture(failure:'configuration'|'adapter'|'cleanup'|'hardware'|'hardware-stop'='configuration'){
 const root=await mkdtemp(join(tmpdir(),'native-bootstrap-')),f=await productMachineFixture(root),configuration=await readFile(f.config.printerConfig,'utf8'),abort=new AbortController(),control=new ProductHostControl(),listening=Promise.withResolvers<string>(),addresses:string[]=[];
 let db:DatabaseStore|undefined,devices=0,processOpens=0,processReleases=0,deviceReleases=0;
 if(failure==='configuration')await writeFile(f.config.printerConfig,'[printer]\nkinematics: invalid\n');
 if(failure==='hardware'||failure==='hardware-stop')await writeFile(f.config.printerConfig,configuration.replace(/step_pin: [^\n]+/u,'step_pin: NO_SUCH_PIN'));
 const factory=createNativeProductHostFactory(f.path,{filesRoot:join(root,'files'),metadataRoot:join(root,'metadata'),standardPrint:{nozzle:200,bed:60},
  async createProcess(){processOpens++;db=await DatabaseStore.open({path:join(root,'api.db')});return {server:{information:f.bindings.server.information,database:db,authorization:{issuer:'https://bootstrap.invalid'}},async release(){processReleases++;if(!db!.status.closed)await db!.close();}};},
  async createAdapter(){devices++;if(devices===1&&['adapter','cleanup'].includes(failure)){if(failure==='cleanup')throw new AggregateError([Error('Adapter acquisition failed'),Error('Adapter cleanup failed')],'Unconfirmed startup cleanup');throw Error('Adapter acquisition failed after confirmed cleanup');}
   return {stops:new Map([...f.bindings.stops].map(([id,stop])=>[id,async(cause:unknown)=>{await stop(cause);if(failure==='hardware-stop'&&id==='mcu')throw Error('Physical stop unconfirmed');}])),output:f.bindings.print.output,lifecycle:f.bindings.print.lifecycle,async authorizePrintFile(){},async release(){deviceReleases++;}};}
 });
 const running=runProductHost(factory,abort.signal,address=>addresses.push(`http://127.0.0.1:${address.port}`),control,address=>listening.resolve(`http://127.0.0.1:${address.port}`));void running.catch(listening.reject);
 let base:string;try{base=await listening.promise;}catch(error){abort.abort();await running.catch(()=>{});await factory.close!().catch(()=>{});await f.close();await rm(root,{recursive:true,force:true});throw error;}const key=await (await db!.wrapNamespace('native_authorization',false)).get('api_key') as string,headers={'x-api-key':key};
 const get=async(path:string)=>{const response=await fetch(base+path,{headers});assert.equal(response.status,200,path);return (await response.json() as any).result;};
 return {root,f,factory,abort,control,running,base,headers,addresses,db:db!,get,get counts(){return {devices,processOpens,processReleases,deviceReleases};},async repair(){await writeFile(f.config.printerConfig,configuration);},async restart(){const response=await fetch(base+'/printer/restart',{method:'POST',headers});assert.equal(response.status,200);assert.equal((await response.json() as any).result,'ok');},async close(){abort.abort();await running.catch(()=>{});await factory.close!().catch(()=>{});await f.close();await rm(root,{recursive:true,force:true});}};
}
for(const failure of ['configuration','adapter','hardware'] as const)test(`initial ${failure} failure retains authorized Moonraker and explicitly recovers actual MCU ownership`,async t=>{
 const f=await fixture(failure);let socket:WebSocket|undefined,pending:ReturnType<typeof request>|undefined;try{
  await until(()=>f.control.status.restart_available);assert.equal(f.addresses.length,0);assert.equal(f.control.status.durable,true);assert.equal(f.control.status.available,false);assert.equal(f.counts.devices,failure==='configuration'?0:1);assert.equal(f.counts.processOpens,1);
  const info=await f.get('/server/info');assert.equal(info.klippy_connected,false);assert.equal(info.native_host.ready,false);assert.deepEqual(info.native_host.mcus,[]);assert.equal(info.native_host.startup_failure,'device_startup_failed');assert.equal((await f.get('/printer/info')).python_path,'');
  assert.equal((await fetch(f.base+'/server/info')).status,401);for(const path of ['/printer/print/status','/printer/objects/list'])assert.equal((await fetch(f.base+path,{headers:f.headers})).status,503,path);
  assert.equal((await fetch(f.base+'/printer/print/start',{method:'POST',headers:{...f.headers,'content-type':'application/json'},body:'{"filename":"first.gcode"}'})).status,503);
  assert.equal((await fetch(f.base+'/server/files/delete_file?path=gcodes/first.gcode',{method:'DELETE',headers:f.headers})).status,503);
  const form=new FormData();form.append('file',new Blob(['; layer_height = 0.2\nG1 X1\n']),'first.gcode');form.append('file_id','first');const upload=await fetch(f.base+'/server/files/upload',{method:'POST',headers:f.headers,body:form});assert.equal(upload.status,200);assert.equal((await upload.json() as any).result.print_started,false);
  assert.equal((await f.get('/server/files/list')).length,1);await f.get('/server/files/metadata?filename=first.gcode');assert.equal(await (await fetch(f.base+'/server/files/gcodes/first.gcode',{headers:f.headers})).text(),'; layer_height = 0.2\nG1 X1\n');assert.equal((await f.get('/server/history/list')).count,0);
  const events:any[]=[];socket=new WebSocket(f.base.replace('http:','ws:')+'/websocket',{headers:f.headers});socket.on('message',b=>events.push(JSON.parse(b.toString())));await once(socket,'open');socket.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'server.connection.identify',params:{client_name:'bootstrap',version:'1',type:'web',url:'https://bootstrap.invalid'}}));await until(()=>events.some(e=>e.id===1));assert(!events.some(e=>e.method==='notify_klippy_ready'));
  const late=Promise.withResolvers<number>();pending=request(f.base+'/printer/restart',{method:'POST',headers:{...f.headers,'content-type':'application/json','transfer-encoding':'chunked'}},response=>{response.resume();response.on('end',()=>late.resolve(response.statusCode!));});pending.on('error',late.reject);pending.write('{');await delay(25);
  await delay(25);assert.equal(f.addresses.length,0);await f.repair();socket.send(JSON.stringify({jsonrpc:'2.0',id:2,method:'printer.restart'}));await until(()=>events.some(e=>e.id===2));assert.equal(events.find(e=>e.id===2).result,'ok');await until(()=>f.control.status.restart_operation?.state==='succeeded');
  assert.deepEqual(f.addresses,[f.base]);assert.equal((await f.get('/server/info')).native_host.ready,true);assert.equal((await f.get('/server/files/list')).length,1);assert.equal(socket.readyState,WebSocket.OPEN);await until(()=>events.some(e=>e.method==='notify_klippy_ready'));await delay(300);assert.equal(events.filter(e=>e.method==='notify_klippy_ready').length,1);
  pending.end('}');assert.equal(await late.promise,503);const counts=f.f.transport.firmware.map(m=>m.stepperConfigs.length);await f.restart();await until(()=>f.control.status.restart_operation?.state==='succeeded');assert.equal(f.addresses.length,2);assert.deepEqual(f.f.transport.firmware.map(m=>m.stepperConfigs.length),counts);assert.equal(f.counts.processOpens,1);
  f.abort.abort();await f.running;assert.equal(f.counts.processReleases,1);assert.equal(f.db.status.closed,true);t.diagnostic(JSON.stringify({failure,readyGenerations:f.addresses.length,...f.counts}));
 }finally{pending?.destroy();socket?.terminate();await f.close();}
});
for(const failure of ['cleanup','hardware-stop'] as const)test(`unconfirmed initial ${failure} keeps a queryable failed service and forbids retry`,async()=>{
 const f=await fixture(failure);try{
  await until(()=>f.counts.devices===1);await until(()=>f.f.transport.stops.some(n=>n>0)||failure==='cleanup');await delay(50);
  const info=await f.get('/server/info');assert.equal(info.native_host.ready,false);assert.equal(info.native_host.hardware_state,'failed');assert.equal(info.native_host.startup_failure,'cleanup_unconfirmed');assert.equal(f.control.status.restart_available,false);assert.equal(f.addresses.length,0);assert.equal((await fetch(f.base+'/printer/restart',{method:'POST',headers:f.headers})).status,503);await f.get('/server/history/list');await f.get('/server/files/list');f.abort.abort();await assert.rejects(f.running,/cleanup/i);assert.equal(f.counts.processReleases,1);
 }finally{await f.close();}
});
test('invalid process configuration never opens an unauthenticated listener or acquires a device',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-bootstrap-invalid-')),f=await productMachineFixture(root),abort=new AbortController();let devices=0,listeners=0,released=0;
 await writeFile(f.config.moonrakerConfig,'[server]\nhost=127.0.0.1\nport=-1');
 const factory=createNativeProductHostFactory(f.path,{filesRoot:join(root,'files'),metadataRoot:join(root,'metadata'),async createProcess(){return {server:{information:f.bindings.server.information,authorize(){},authorizeNotification(){}},async release(){released++;}};},async createAdapter(){devices++;throw Error('Unexpected device acquisition');}});
 try{await assert.rejects(runProductHost(factory,abort.signal,()=>listeners++,undefined,()=>listeners++),/port/);assert.equal(listeners,0);assert.equal(devices,0);assert.equal(released,1);}finally{abort.abort();await factory.close!();await f.close();await rm(root,{recursive:true,force:true});}
});
test('offline retry cannot change process identity or acquire replacement resources',async()=>{
 const f=await fixture();try{
  await until(()=>f.control.status.restart_available);await f.repair();const manifest=await readFile(f.f.path,'utf8'),changed=JSON.parse(manifest);changed.journalPath=join(f.root,'replacement.db');await writeFile(f.f.path,JSON.stringify(changed));await f.restart();await until(()=>f.control.status.restart_operation?.state==='failed');assert.equal(f.counts.devices,0);assert.equal(f.counts.processOpens,1);assert.equal(f.control.status.restart_available,true);await f.get('/server/history/list');
  await writeFile(f.f.path,manifest);await f.restart();await until(()=>f.control.status.restart_operation?.state==='succeeded');assert.equal(f.counts.devices,1);assert.deepEqual(f.addresses,[f.base]);f.abort.abort();await f.running;
 }finally{await f.close();}
});
test('shutdown waits for ignored first adapter cancellation before closing the bootstrapped database',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-bootstrap-shutdown-')),f=await productMachineFixture(root),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),abort=new AbortController(),order:string[]=[];let db:DatabaseStore|undefined,listeners=0,ready=0;
 const factory=createNativeProductHostFactory(f.path,{filesRoot:join(root,'files'),metadataRoot:join(root,'metadata'),async createProcess(){db=await DatabaseStore.open({path:join(root,'api.db')});return {server:{information:f.bindings.server.information,database:db,authorization:{issuer:'https://bootstrap.invalid'}},async release(){order.push('process');if(!db!.status.closed)await db!.close();}};},async createAdapter(){entered.resolve();await release.promise;return {stops:f.bindings.stops,output:f.bindings.print.output,lifecycle:f.bindings.print.lifecycle,async authorizePrintFile(){},async release(){order.push('device');}};}});
 let finished=false;const running=runProductHost(factory,abort.signal,()=>ready++,undefined,()=>listeners++);void running.then(()=>finished=true,()=>finished=true);
 try{await entered.promise;assert.equal(listeners,1);assert.equal(ready,0);abort.abort();await delay(25);assert.equal(finished,false);assert.equal(db!.status.closed,false);release.resolve();await running;assert.equal(db!.status.closed,true);assert.deepEqual(order,['device','process']);assert.equal(ready,0);}finally{release.resolve();abort.abort();await running.catch(()=>{});await factory.close!();await f.close();await rm(root,{recursive:true,force:true});}
});
