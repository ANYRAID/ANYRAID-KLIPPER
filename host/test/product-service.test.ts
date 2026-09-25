import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {configuredPrinterFixture} from './helpers/configured-printer.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {startProductService,type ProductServiceOptions} from '../src/runtime/product-service.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
import {startConfiguredProductService} from '../src/runtime/product-service.ts';
import {productTransports} from './helpers/product-transports.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
async function fixture(){
 const f=await configuredPrinterFixture(false,false),dir=await mkdtemp(join(tmpdir(),'product-service-')),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'}),maintenanceGate=new MaintenanceGate(),configPath=join(dir,'moonraker.conf');
 await writeFile(configPath,'[server]\nhost=127.0.0.1\nport=0');
 const product={journal,maintenanceGate,limits:{maxNozzle:300,maxBed:130}};const serviceOptions:ProductServiceOptions={configPath,server:{information:{connected:false,state:'disconnected' as const,components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize:(_method,_params,context)=>{if(context.request.headers['x-api-key']!=='test')throw new ApiError(401,'Denied');return {username:'operator'};}}};
 return {...f,dir,journal,product,serviceOptions,async dispose(){await f.close();await journal.close();await rm(dir,{recursive:true,force:true});}};
}
test('configuration-driven product service opens real UARTs and owns the complete shutdown',async()=>{
 const f=await fixture(),transport=await productTransports(f.reader);let owner:Awaited<ReturnType<typeof startConfiguredProductService>>|undefined;
 try{
  owner=await startConfiguredProductService(transport.reader,transport.policies,f.product,{...f.serviceOptions,machine:{enableLeadTime:.001,fanMinimumScheduleTime:.001},hardware:f.options.hardware,print:f.options.print},f.signal);
  const url=`http://127.0.0.1:${owner.address.port}/printer/print/status`,response=await fetch(url,{headers:{'x-api-key':'test'}});
  assert.equal(response.status,200);assert.equal((await response.json() as any).result.state,'idle');
  assert.equal(owner.printer.initial.emitters.length,4);assert.equal(owner.printer.linear.kinematics.status.homedAxes,'');assert.equal(owner.printer.controller.durable,true);
  assert.equal(transport.firmware[0].stepperConfigs.length,4);assert(transport.firmware[1].outputs.some(o=>o.name==='config_analog_in'));assert(transport.firmware.every(f=>f.motion.length===0));
  const first=owner.close();assert.equal(owner.close(),first);await first;assert.deepEqual(transport.stops,[1,1]);assert.equal(f.product.maintenanceGate.status.closed,true);await assert.rejects(fetch(url));
 }finally{await owner?.close();await transport.close();await f.dispose();}
});
test('configuration-driven startup rejects topology before any UART acquisition',async()=>{
 const f=await fixture(),transport=await productTransports(f.reader);
 try{
  const reader=new ConfigurationReader(new ConfigurationSource('/bad.cfg',{...transport.reader.source.original,extruder1:{}},[]),null);
  assert.throws(()=>startConfiguredProductService(reader,transport.policies,f.product,{...f.serviceOptions,machine:{enableLeadTime:.001,fanMinimumScheduleTime:.001},print:f.options.print},f.signal),/topology/);
  assert(transport.firmware.every(f=>f.stepperConfigs.length===0&&f.outputs.length===0));assert.deepEqual(transport.stops,[0,0]);assert.equal(f.product.maintenanceGate.status.closed,false);
 }finally{await transport.close();await f.dispose();}
});
test('native service listens only with ready hardware and applies authorization',async()=>{
 const f=await fixture(),controller=new AbortController();let owner:Awaited<ReturnType<typeof startProductService>>|undefined;
 try{
  owner=await startProductService(f.reader,f.connections,'mcu',f.layout,f.options,f.product,f.serviceOptions,controller.signal);

  const url=`http://127.0.0.1:${owner.address.port}`;
  const denied=await fetch(url+'/printer/print/status');assert.equal(denied.status,401);await denied.arrayBuffer();
  const accepted=await fetch(url+'/printer/print/status',{headers:{'x-api-key':'test'}});assert.equal(accepted.status,200);assert.equal((await accepted.json() as any).result.state,'idle');
  assert.equal(owner.printer.hardware.status.state,'ready');assert.equal(owner.printer.controller.durable,true);assert.equal(f.firmware[0].motion.length,0);
  controller.abort(new Error('startup complete'));assert.equal(owner.printer.hardware.status.state,'ready');
  const first=owner.close();assert.equal(owner.close(),first);await first;assert.deepEqual(f.stops,[1,1]);assert.equal(owner.printer.maintenanceGate.status.closed,true);await assert.rejects(fetch(url+'/printer/print/status'));
 }finally{await owner?.close();await f.dispose();}
});
test('listener failure closes already configured native hardware',async()=>{
 const f=await fixture(),blocker=createServer();await new Promise<void>(resolve=>blocker.listen(0,'127.0.0.1',resolve));
 try{
  const address=blocker.address();assert(address&&typeof address!=='string');await writeFile(f.serviceOptions.configPath,`[server]\nhost=127.0.0.1\nport=${address.port}`);
  await assert.rejects(startProductService(f.reader,f.connections,'mcu',f.layout,f.options,f.product,f.serviceOptions,f.signal));
  assert.deepEqual(f.stops,[1,1]);assert.equal(f.product.maintenanceGate.status.closed,true);assert.equal(f.firmware[0].motion.length,0);assert.equal(await f.journal.active(),null);
 }finally{await new Promise<void>((resolve,reject)=>blocker.close(error=>error?reject(error):resolve()));await f.dispose();}
});
test('configuration load failure closes connected native product',async()=>{
 const f=await fixture();try{
  f.serviceOptions.configPath=join(f.dir,'missing.conf');await assert.rejects(startProductService(f.reader,f.connections,'mcu',f.layout,f.options,f.product,f.serviceOptions,f.signal));assert.deepEqual(f.stops,[1,1]);assert.equal(f.product.maintenanceGate.status.closed,true);
 }finally{await f.dispose();}
});
test('cancelled startup closes a server returned late from configuration loading',async t=>{
 const f=await fixture(),controller=new AbortController(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),load=ConfiguredMoonraker.load;let late:ConfiguredMoonraker|undefined;
 t.mock.method(ConfiguredMoonraker,'load',async(...args:Parameters<typeof load>)=>{late=await load(...args);entered.resolve();await release.promise;return late;});
 try{
  let settled=false;const pending=startProductService(f.reader,f.connections,'mcu',f.layout,f.options,f.product,f.serviceOptions,controller.signal).finally(()=>{settled=true;}),rejected=assert.rejects(pending);
  await entered.promise;controller.abort(new Error('cancel service loading'));await Promise.resolve();assert.equal(settled,false);release.resolve();await rejected;
  assert.deepEqual(f.stops,[1,1]);assert.equal(f.product.maintenanceGate.status.closed,true);await assert.rejects(late!.start(),/stopping/);
 }finally{release.resolve();await late?.close();await f.dispose();}
});
test('native server information follows physical stop while cleanup acknowledgement is pending',async()=>{
 const f=await fixture(),held=Promise.withResolvers<void>();let owner:Awaited<ReturnType<typeof startProductService>>|undefined,stopping:Promise<void>|undefined;
 try{
  const connections=f.connections.map(c=>({...c,async stopDevice(cause:unknown){await c.stopDevice();await held.promise;}}));
  owner=await startProductService(f.reader,connections,'mcu',f.layout,f.options,f.product,f.serviceOptions,f.signal);
  const url=`http://127.0.0.1:${owner.address.port}/server/info`,read=async()=>{const response=await fetch(url,{headers:{'x-api-key':'test'}});assert.equal(response.status,200);return (await response.json() as any).result;};
  let info=await read();assert.equal(info.klippy_connected,false);assert.equal(info.klippy_state,'disconnected');assert.equal(info.native_host.ready,true);assert.equal(info.native_host.homed_axes,'');assert.equal(info.native_host.mcus.length,2);assert(info.native_host.mcus.every((m:any)=>m.state==='ready'));
  stopping=owner.printer.group.stop(new Error('private hardware fault'));void stopping.catch(()=>{});
  info=await read();assert.equal(info.native_host.ready,false);assert.equal(info.native_host.group_state,'stopping');assert(!JSON.stringify(info).includes('private hardware fault'));
  held.resolve();await stopping;info=await read();assert.equal(info.native_host.ready,false);assert.equal(info.native_host.group_state,'stopped');assert.deepEqual(f.stops,[1,1]);
 }finally{held.resolve();await stopping?.catch(()=>{});await owner?.close();await f.dispose();}
});
