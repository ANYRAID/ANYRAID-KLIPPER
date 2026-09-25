import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,open} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
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
test('authorized HTTP pressure tuning completes while a paused native file retains its dispatch',async()=>{
 const f=await fixture();let owner:Awaited<ReturnType<typeof startProductService>>|undefined;
 try{
  const path=join(f.dir,'pressure.gcode');await writeFile(path,Array.from({length:256},(_,i)=>`G1 X${(i+1)/100} F60\n`).join(''));
  f.options.print.startupHoming={mode:'require_homed',axes:[0]};f.options.print.open=async()=>GCodeFileReader.adopt(await open(path,'r'));
  owner=await startProductService(f.reader,f.connections,'mcu',f.layout,f.options,f.product,f.serviceOptions,f.signal);owner.printer.linear.kinematics.markHomed([0]);
  const base=`http://127.0.0.1:${owner.address.port}`,headers={'x-api-key':'test','content-type':'application/json'},controller=owner.printer.controller;
  const post=async(action:string,body:unknown,authorized=true)=>{const response=await fetch(base+'/printer/print/'+action,{method:'POST',headers:authorized?headers:{'content-type':'application/json'},body:JSON.stringify(body)});const result=await response.json() as any;return {status:response.status,result};};
  const request={version:1 as const,requestId:'pressure-job',fileId:'file',nozzle:0,bed:0};await controller.start(request);
  const deadline=performance.now()+5000;while(!f.firmware[0].motion.some(m=>m.name==='queue_step')){assert(performance.now()<deadline);await delay(2);}
  const paused=await post('pause',{request_id:request.requestId,state_token:controller.stateToken});assert.equal(paused.status,200);assert.equal(controller.state,'paused');assert.equal(owner.printer.print.file.status.file?.checkpointHeld,true);
  const settings={version:1,request_id:request.requestId,state_token:controller.stateToken,extruder:'extruder',advance:.1,smooth_time:.08},before=controller.stateToken;
  assert.equal((await post('pressure_advance',settings,false)).status,401);assert.equal(controller.stateToken,before);
  const changed=await post('pressure_advance',settings);assert.equal(changed.status,200,JSON.stringify(changed.result));assert.equal(controller.state,'paused');assert.notEqual(controller.stateToken,before);assert.equal(owner.printer.print.file.status.file?.checkpointHeld,true);
  assert.equal((await post('pressure_advance',settings)).status,409);
  const response=await fetch(base+'/printer/objects/query?extruder=pressure_advance,smooth_time',{headers});assert.deepEqual((await response.json() as any).result.status.extruder,{pressure_advance:.1,smooth_time:.08});
  const resumed=await post('resume',{request_id:request.requestId,state_token:controller.stateToken});assert.equal(resumed.status,200,JSON.stringify(resumed.result));
  const finish=performance.now()+10000;while(String(controller.state)!=='completed'){assert(controller.failure===undefined,String(controller.failure));assert(performance.now()<finish);await delay(5);}
  assert.deepEqual(owner.printer.linear.port.position(),[2.56,0,0,0]);assert.deepEqual(owner.printer.print.gcode.pressureAdvance!.pressureAdvance,{advance:.1,smoothTime:.08});
 }finally{await owner?.close();await f.dispose();}
});
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
test('native object queries expose actual coordinate state and configured sensors without movement',async()=>{
 const f=await fixture();let owner:Awaited<ReturnType<typeof startProductService>>|undefined;
 try{
  const reader=new ConfigurationReader(new ConfigurationSource('/retraction-service.cfg',{...f.reader.source.original,firmware_retraction:{retract_length:'.25'}},[]),null);
  owner=await startProductService(reader,f.connections,'mcu',f.layout,f.options,f.product,f.serviceOptions,f.signal);const base=`http://127.0.0.1:${owner.address.port}`,headers={'x-api-key':'test'};
  const listing=await fetch(base+'/printer/objects/list',{headers}),names=(await listing.json() as any).result.objects;for(const name of ['native_host','toolhead','gcode_move','heaters','extruder','heater_bed','fan','virtual_sdcard','print_stats'])assert(names.includes(name));
  const retractResponse=await fetch(base+'/printer/objects/query?firmware_retraction',{headers});assert.deepEqual((await retractResponse.json() as any).result.status.firmware_retraction,{retract_length:.25,retract_speed:20,unretract_extra_length:0,unretract_speed:10});assert(names.includes('firmware_retraction'));
  owner.printer.print.gcode.display.setMessage('打印中');owner.printer.print.gcode.display.updateProgress({P:'37.5'});
  const pressure=owner.printer.print.gcode.pressureAdvance!;assert.equal(pressure.name,'extruder');owner.printer.print.gcode.enable();
  await owner.printer.print.gcode.dispatch.execute('SET_PRESSURE_ADVANCE ADVANCE=0 SMOOTH_TIME=0.12',{boundary:'checkpoint'});
  const pressureResponse=await fetch(base+'/printer/objects/query?extruder=pressure_advance,smooth_time,temperature&heater_bed=pressure_advance&toolhead=extruder',{headers});
  assert.deepEqual((await pressureResponse.json() as any).result.status,{extruder:{pressure_advance:0,smooth_time:.12,temperature:owner.printer.hardware.analog[0].runtime.objectStatus.temperature},heater_bed:{pressure_advance:null},toolhead:{extruder:'extruder'}});
  await owner.printer.print.gcode.dispatch.execute('SET_PRESSURE_ADVANCE ADVANCE=0 SMOOTH_TIME=0.04',{boundary:'checkpoint'});
  const displayResponse=await fetch(base+'/printer/objects/query?display_status',{headers});assert.deepEqual((await displayResponse.json() as any).result.status.display_status,{progress:.375,message:'打印中'});assert(names.includes('display_status'));
  // Populate the coordinate model without granting public G-code admission.
  owner.printer.print.gcode.coordinates.execute('G92',{X:1.005,E:2.675});owner.printer.print.gcode.coordinates.execute('M220',{S:150});
  owner.printer.linear.port.updateVelocityLimits({maxVelocity:42,maxAccel:123,squareCornerVelocity:2,minCruiseRatio:.25});
  const limitsResponse=await fetch(base+'/printer/objects/query?toolhead=max_velocity,max_accel,square_corner_velocity,minimum_cruise_ratio',{headers});assert.deepEqual((await limitsResponse.json() as any).result.status.toolhead,{max_velocity:42,max_accel:123,square_corner_velocity:2,minimum_cruise_ratio:.25});
  const response=await fetch(base+'/printer/objects/query?gcode_move&toolhead=homed_axes,position,axis_minimum&extruder&heaters&virtual_sdcard&print_stats&missing=absent',{headers}),result=(await response.json() as any).result;
  assert(Number.isFinite(result.eventtime));assert.equal(result.status.gcode_move.speed_factor,1.5);assert.equal(result.status.gcode_move.speed,1500);assert.equal(result.status.gcode_move.gcode_position[0],1.005);assert.equal(result.status.toolhead.homed_axes,'');assert.deepEqual(result.status.toolhead.position,owner.printer.linear.port.position());assert.equal(result.status.toolhead.axis_minimum.length,4);assert.deepEqual(result.status.extruder,{...owner.printer.hardware.analog[0].runtime.objectStatus,pressure_advance:0,smooth_time:.04});assert(result.status.heaters.available_heaters.includes('extruder'));assert.deepEqual(result.status.virtual_sdcard,{progress:0,is_active:false,file_position:0,file_size:0});assert.deepEqual(result.status.print_stats,{state:'standby',message:'',info:{total_layer:null,current_layer:null}});assert.deepEqual(result.status.missing,{absent:null});assert(f.firmware.every(f=>f.motion.length===0));
 }finally{await owner?.close();await f.dispose();}
});
test('native WebSocket subscriptions deliver real deltas and disconnect after notification authorization loss',async()=>{
 const f=await fixture();let owner:Awaited<ReturnType<typeof startProductService>>|undefined,ws:WebSocket|undefined,allowed=true;
 f.serviceOptions.server.authorizeNotification=()=>{if(!allowed)throw new ApiError(401,'Revoked');};
 try{
  owner=await startProductService(f.reader,f.connections,'mcu',f.layout,f.options,f.product,f.serviceOptions,f.signal);
  ws=new WebSocket(`ws://127.0.0.1:${owner.address.port}/websocket`,{headers:{'x-api-key':'test'}});await once(ws,'open');
  const receive=()=>once(ws!,'message',{signal:AbortSignal.timeout(3000)}).then(([data])=>JSON.parse(String(data)));
  let reply=receive();ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'printer.objects.subscribe',params:{objects:{gcode_move:['speed_factor'],native_host:['ready'],display_status:['message','progress']}}}));const initial=await reply;assert.deepEqual(initial.result.status,{gcode_move:{speed_factor:1},native_host:{ready:true},display_status:{message:null,progress:0}});
  reply=receive();owner.printer.print.gcode.coordinates.execute('M220',{S:150});const update=await reply;assert.equal(update.method,'notify_status_update');assert.deepEqual(update.params[0],{gcode_move:{speed_factor:1.5}});assert(update.params[1]>initial.result.eventtime);
  reply=receive();owner.printer.print.gcode.display.setMessage('准备完成');owner.printer.print.gcode.display.updateProgress({P:'25'});const display=await reply;assert.deepEqual(display.params[0],{display_status:{message:'准备完成',progress:.25}});
  reply=receive();ws.send(JSON.stringify({jsonrpc:'2.0',id:2,method:'printer.objects.subscribe',params:{objects:{extruder:['pressure_advance','smooth_time']}}}));assert.deepEqual((await reply).result.status,{extruder:{pressure_advance:0,smooth_time:.04}});
  reply=receive();owner.printer.print.gcode.enable();await owner.printer.print.gcode.dispatch.execute('SET_PRESSURE_ADVANCE ADVANCE=0 SMOOTH_TIME=0.12',{boundary:'checkpoint'});const pressureUpdate=await reply;assert.equal(pressureUpdate.method,'notify_status_update');assert.deepEqual(pressureUpdate.params[0],{extruder:{smooth_time:.12}});
  allowed=false;const closed=once(ws,'close',{signal:AbortSignal.timeout(3000)});await owner.printer.print.gcode.dispatch.execute('SET_PRESSURE_ADVANCE ADVANCE=0 SMOOTH_TIME=0.04',{boundary:'checkpoint'});await closed;assert(f.firmware.every(f=>f.motion.length===0));
 }finally{ws?.terminate();await owner?.close();await f.dispose();}
});
