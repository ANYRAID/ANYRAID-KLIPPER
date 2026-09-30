import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {NativeObjects,type NativeObjectReader} from '../src/moonraker/native-objects.ts';
import {PrintController} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {productHostFixture} from './helpers/product-host-profile.ts';
import {startConfiguredMachineService} from '../src/runtime/product-service.ts';
const information={connected:false,state:'disconnected' as const,components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]};
test('native retirement retains JWT, database and socket; drains held work and never samples released devices',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-retire-')),config=join(dir,'moonraker.conf'),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'}),db=await DatabaseStore.open({path:join(dir,'api.db')}),gate=new MaintenanceGate();
 const controller=new PrintController({async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){}},{maxNozzle:300,maxBed:130},{},{journal,maintenanceGate:gate});
 let service:ConfiguredMoonraker|undefined,socket:WebSocket|undefined,released=false,reads=0;
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const objects=new NativeObjects(new Map<string,NativeObjectReader>([['heaters',()=>({available_sensors:['temperature_sensor chamber'],available_monitors:[]})],['temperature_sensor chamber',()=>{if(released)throw Error('released sensor');reads++;return {temperature:20};}]]),()=>performance.now()/1000);
 const events:any[]=[];
 try{
  await writeFile(config,'[server]\nhost=127.0.0.1\nport=0\n');await db.registerNamespace('probe');await db.insert('probe','value',42);
  service=await ConfiguredMoonraker.loadAuthorized(config,{information,database:db,authorization:{issuer:'https://retirement.invalid'},productPrint:controller,maintenanceGate:gate,nativeObjects:objects,systemInformation:{},procStats:{},nativePrinterIdentity:{configFile:join(dir,'printer.cfg'),softwareVersion:'test'},nativeHost:()=>{if(released)throw Error('released hardware');return {group_state:'ready',hardware_state:'ready',print_state:controller.state,homed_axes:'',closing:false,admission_closed:gate.status.closed,maintenance:false,mcus:[{id:'mcu',state:'ready'}]};}});
  const {port}=await service.start(),base=`http://127.0.0.1:${port}`,key=service.authorization!.localApiKey();
  const created=await (await fetch(base+'/access/user',{method:'POST',headers:{'x-api-key':key,'content-type':'application/json'},body:JSON.stringify({username:'operator',password:'test-only-password'})})).json() as any;
  const token=created.result.token,refresh=created.result.refresh_token,headers={authorization:'Bearer '+token};assert.equal(typeof token,'string');
  socket=new WebSocket(`ws://127.0.0.1:${port}/websocket`,{headers});socket.on('message',bytes=>events.push(JSON.parse(bytes.toString())));await once(socket,'open');
  socket.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'server.connection.identify',params:{client_name:'retirement-test',version:'1',type:'web',url:'https://retirement.invalid'}}));
  const until=async(check:()=>boolean)=>{const end=performance.now()+4000;while(!check()){assert(performance.now()<end,'Retirement event timeout');await delay(5);}};
  await until(()=>events.some(e=>e.id===1));assert.equal(events.find(e=>e.id===1).error,undefined);
  service.endpoints.register({endpoint:'/printer/held',methods:['GET']},async(_p,_v,c)=>{entered.resolve();await release.promise;c.signal.throwIfAborted();return 'stale';});
  const held=fetch(base+'/printer/held',{headers});await entered.promise;let finished=false;
  const retirement=service.retireNativePrinter(),retired=retirement.then(()=>{finished=true;});assert.equal(service.retireNativePrinter(),retirement);
  released=true;await delay(10);assert.equal(finished,false);assert.equal(service.nativeGenerationStatus?.pending,1);
  assert.equal((await fetch(base+'/printer/print/status')).status,401);assert.equal((await fetch(base+'/printer/print/status',{headers})).status,503);
  const info=(await (await fetch(base+'/server/info',{headers})).json() as any).result;assert.equal(info.klippy_connected,false);assert.equal(info.klippy_state,'disconnected');assert.equal(info.native_host.ready,false);assert.deepEqual(info.native_host.mcus,[]);
  assert.equal((await fetch(base+'/printer/info',{headers})).status,200);assert.equal((await fetch(base+'/machine/system_info',{headers})).status,200);
  release.resolve();assert.equal((await held).status,503);await retired;assert.equal(service.nativeGenerationStatus?.state,'stopping');
  const count=reads;await delay(1100);assert.equal(reads,count);assert.equal(service.temperatureStoreStatus?.running,false);assert.equal(service.temperatureStoreStatus?.closed,false);
  await until(()=>events.some(e=>e.method==='notify_klippy_disconnected'));assert.equal(socket.readyState,WebSocket.OPEN);
  socket.send(JSON.stringify({jsonrpc:'2.0',id:2,method:'server.info'}));await until(()=>events.some(e=>e.id===2));assert.equal(events.find(e=>e.id===2).result.klippy_connected,false);
  assert.equal(db.status.closed,false);assert.equal((await (await fetch(base+'/server/database/item?namespace=probe&key=value',{headers})).json() as any).result.value,42);
  const refreshed=await fetch(base+'/access/refresh_jwt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({refresh_token:refresh})});assert.equal(refreshed.status,200);assert.equal(service.authorization!.localApiKey(),key);
 }finally{release.resolve();socket?.terminate();await service?.close();await journal.close();await db.close();await rm(dir,{recursive:true,force:true});}
});
for(const failStop of [false,true])test(`product owner retires actual transport group but retains query service (stop failure=${failStop})`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'product-retire-')),f=await productHostFixture(dir),abort=new AbortController();let owner:Awaited<ReturnType<typeof startConfiguredMachineService>>|undefined;
 const policies=new Map(f.profile.policies);if(failStop){const p=policies.get('mcu')!;policies.set('mcu',{...p,async stopDevice(cause){await p.stopDevice(cause);throw Error('physical stop not confirmed');}});}
 try{
  owner=await startConfiguredMachineService(f.profile.reader,policies,f.profile.product,f.profile.options,abort.signal);
  const base=`http://127.0.0.1:${owner.address.port}`,headers={'x-api-key':'test'},begin=performance.now(),retired=owner.retirePrinter();assert.equal(owner.retirePrinter(),retired);
  if(failStop)await assert.rejects(retired,/printer cleanup/);else await retired;
  assert(f.transport.stops.every(n=>n===1));assert.equal(owner.server.nativeGenerationStatus?.state,failStop?'failed':'stopped');
  await f.profile.release();const response=await fetch(base+'/server/info',{headers});assert.equal(response.status,200);const body=await response.json() as any;assert.equal(body.result.native_host.ready,false);assert.deepEqual(body.result.native_host.mcus,[]);
  assert.equal((await fetch(base+'/printer/objects/query?toolhead=position',{headers})).status,503);assert.equal(owner.server.status.phase,'listening');
  t.diagnostic(JSON.stringify({nativeRetirement:{failStop,wallMs:performance.now()-begin,scope:owner.server.nativeGenerationStatus,physicalStopCallbacks:f.transport.stops,listener:owner.server.status.phase}}));
 }finally{abort.abort();await owner?.close().catch(()=>{});await f.profile.release();await rm(dir,{recursive:true,force:true});}
});
