import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,open} from 'node:fs/promises';
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
test('toolhead status keeps emitting the real MCU time after a completed print',async()=>{
 const f=await fixture();let owner:Awaited<ReturnType<typeof startProductService>>|undefined,socket:WebSocket|undefined;
 f.serviceOptions.server.authorizeNotification=()=>{};
 try{
  const path=join(f.dir,'terminal.gcode');await writeFile(path,'G1 X0.05 F60\n');
  f.options.print.startupHoming={mode:'require_homed',axes:[0]};f.options.print.open=async()=>GCodeFileReader.adopt(await open(path,'r'));
  owner=await startProductService(f.reader,f.connections,'mcu',f.layout,f.options,f.product,f.serviceOptions,f.signal);owner.printer.linear.kinematics.markHomed([0]);
  const base=`http://127.0.0.1:${owner.address.port}`,headers={'x-api-key':'test'},query=async()=>{const response=await fetch(base+'/printer/objects/query?toolhead=estimated_print_time',{headers});assert.equal(response.status,200);return (await response.json() as any).result.status.toolhead.estimated_print_time;};
  const before=await query();assert.equal(typeof before,'number');assert(Number.isFinite(before));
  socket=new WebSocket(base.replace('http:','ws:')+'/websocket',{headers});const terminal=Promise.withResolvers<void>(),subscribed=Promise.withResolvers<void>();void terminal.promise.catch(()=>{});void subscribed.promise.catch(()=>{});let sawComplete=false,terminalTime=0,followupTime=0;
  socket.on('message',bytes=>{const message=JSON.parse(String(bytes));if(message.error){const error=Error(JSON.stringify(message.error));terminal.reject(error);subscribed.reject(error);}if(message.id===1&&message.result)subscribed.resolve();if(message.method!=='notify_status_update')return;
   const [status,time]=message.params;if(status.print_stats?.state==='complete'){sawComplete=true;terminalTime=time;}
   if(sawComplete&&time>=terminalTime+1&&typeof status.toolhead?.estimated_print_time==='number'){followupTime=time;terminal.resolve();}
  });await once(socket,'open');
  const timeout=setTimeout(()=>{const error=Error('No advancing toolhead status after terminal print');terminal.reject(error);subscribed.reject(error);},5000);
  try{socket.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'printer.objects.subscribe',params:{objects:{toolhead:['estimated_print_time'],print_stats:['state'],virtual_sdcard:['progress']}}}));await subscribed.promise;await owner.printer.controller.start({version:1,requestId:'terminal-status',fileId:'file',nozzle:0,bed:0});await terminal.promise;}finally{clearTimeout(timeout);}
  assert.equal(owner.printer.controller.state,'completed');assert(followupTime>=terminalTime+1);assert(await query()>before);assert.deepEqual(owner.printer.linear.port.position(),[.05,0,0,0]);
 }finally{socket?.terminate();await owner?.close();await f.dispose();}
});
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
test('configuration-driven startup rejects incomplete extruder configuration before any UART acquisition',async()=>{
 const f=await fixture(),transport=await productTransports(f.reader);
 try{
  const reader=new ConfigurationReader(new ConfigurationSource('/bad.cfg',{...transport.reader.source.original,extruder1:{}},[]),null);
  assert.throws(()=>startConfiguredProductService(reader,transport.policies,f.product,{...f.serviceOptions,machine:{enableLeadTime:.001,fanMinimumScheduleTime:.001},print:f.options.print},f.signal),/\[extruder1\].*nozzle_diameter/);
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
  const deniedHelp=await fetch(url+'/printer/gcode/help');assert.equal(deniedHelp.status,401);await deniedHelp.arrayBuffer();
  const help=await fetch(url+'/printer/gcode/help',{headers:{'x-api-key':'test'}});assert.equal(help.status,200);const descriptions=(await help.json()).result;
  assert.equal(descriptions.SET_PRESSURE_ADVANCE,'Set pressure advance and smoothing time');assert.equal(descriptions.SET_SERVO,undefined);assert.equal(descriptions.START_PRINT,undefined);
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
 t.mock.method(ConfiguredMoonraker,'load',async(...args:Parameters<typeof load>)=>{late=await load.apply(ConfiguredMoonraker,args);entered.resolve();await release.promise;return late;});
 try{
  let settled=false;const pending=startProductService(f.reader,f.connections,'mcu',f.layout,f.options,f.product,f.serviceOptions,controller.signal).finally(()=>{settled=true;}),rejected=assert.rejects(pending);
  await Promise.race([entered.promise,pending.then(()=>{throw new Error('Startup bypassed the held loader');})]);controller.abort(new Error('cancel service loading'));await Promise.resolve();assert.equal(settled,false);release.resolve();await rejected;
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
test('temperature fan product object combines live temperature, target and cooling speed',async()=>{
 const f=await fixture();let owner:Awaited<ReturnType<typeof startProductService>>|undefined;
 try{
  const section='temperature_fan chamber',path=join(f.dir,'host-temp');await writeFile(path,'25000\n');
  const reader=new ConfigurationReader(new ConfigurationSource('/temperature-fan.cfg',{...f.reader.source.original,[section]:{pin:'aux:PA13',sensor_type:'temperature_host',sensor_path:path,min_temp:'0',max_temp:'100',control:'watermark'}},[]),null);
  owner=await startProductService(reader,f.connections,'mcu',{...f.layout,fans:[...f.layout.fans,{section,minimumScheduleTime:.02}],sensors:[{section}]},f.options,f.product,f.serviceOptions,f.signal);
  const end=performance.now()+2000;while(owner.printer.hardware.fans.find(f=>f.section===section)!.runtime.status.speed!==0){assert(performance.now()<end);await delay(5);}
  const response=await fetch(`http://127.0.0.1:${owner.address.port}/printer/objects/query?temperature_fan%20chamber&heaters`,{headers:{'x-api-key':'test'}}),result=(await response.json() as any).result.status;
  assert.deepEqual(result[section],{temperature:25,target:40,speed:0,rpm:null});assert(result.heaters.available_sensors.includes(section));assert(f.firmware.every(f=>f.motion.length===0));
  const url=`http://127.0.0.1:${owner.address.port}/printer/settings/temperature_fan`,headers={'x-api-key':'test','content-type':'application/json'};
  const get=await fetch(url+'?name='+encodeURIComponent(section),{headers}),state=(await get.json() as any).result;
  const request={name:section,version:1,state_token:state.state_token,target:20,min_speed:.2,max_speed:.6};
  assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)})).status,401);
  const post=await fetch(url,{method:'POST',headers,body:JSON.stringify(request)}),receipt=(await post.json() as any).result;assert.equal(post.status,200);assert.equal(receipt.target,20);
  const retry=await fetch(url,{method:'POST',headers,body:JSON.stringify(request)});assert.deepEqual((await retry.json() as any).result,receipt);
  const deadline=performance.now()+2500;while(owner.printer.hardware.fans.find(f=>f.section===section)!.runtime.status.speed!==.6){assert(performance.now()<deadline);await delay(5);}
  const rejected=await fetch(url,{method:'POST',headers,body:JSON.stringify({...request,state_token:receipt.state_token,target:30,min_speed:.9})});assert.equal(rejected.status,400);assert.equal(owner.printer.hardware.temperatureFans[0].control.settings.target,20);
 }finally{await owner?.close();await f.dispose();}
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
  assert(Number.isFinite(result.eventtime));assert.equal(result.status.gcode_move.speed_factor,1.5);assert.equal(result.status.gcode_move.speed,1500);assert.equal(result.status.gcode_move.gcode_position[0],1.005);assert.equal(result.status.toolhead.homed_axes,'');assert.deepEqual(result.status.toolhead.position,owner.printer.linear.port.position());assert.equal(result.status.toolhead.axis_minimum.length,4);assert.deepEqual(result.status.extruder,{...owner.printer.hardware.analog[0].runtime.objectStatus,pressure_advance:0,smooth_time:.04});assert(result.status.heaters.available_heaters.includes('extruder'));assert.deepEqual(result.status.virtual_sdcard,{progress:0,is_active:false,file_position:0,file_size:0});assert.deepEqual(result.status.print_stats,{print_duration:0,total_duration:0,filament_used:0,state:'standby',message:'',info:{total_layer:null,current_layer:null}});assert.deepEqual(result.status.missing,{absent:null});assert(f.firmware.every(f=>f.motion.length===0));
 }finally{await owner?.close();await f.dispose();}
});
test('native WebSocket subscriptions deliver real deltas and disconnect after notification authorization loss',async()=>{
 const f=await fixture();let owner:Awaited<ReturnType<typeof startProductService>>|undefined,ws:WebSocket|undefined,allowed=true;
 f.serviceOptions.server.authorizeNotification=()=>{if(!allowed)throw new ApiError(401,'Revoked');};
 try{
  owner=await startProductService(f.reader,f.connections,'mcu',f.layout,f.options,f.product,f.serviceOptions,f.signal);
  ws=new WebSocket(`ws://127.0.0.1:${owner.address.port}/websocket`,{headers:{'x-api-key':'test'}});await once(ws,'open');
  const receive=(method?:string)=>new Promise<any>((resolve,reject)=>{
   const socket=ws!,timer=setTimeout(()=>{socket.off('message',message);reject(new Error('WebSocket response timeout'));},3000);
   const message=(data:unknown)=>{const value=JSON.parse(String(data));if(method&&value.method!==method)return;clearTimeout(timer);socket.off('message',message);resolve(value);};socket.on('message',message);
  });
  let reply=receive();ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'printer.objects.subscribe',params:{objects:{gcode_move:['speed_factor'],native_host:['ready'],display_status:['message','progress']}}}));const initial=await reply;assert.deepEqual(initial.result.status,{gcode_move:{speed_factor:1},native_host:{ready:true},display_status:{message:null,progress:0}});
  reply=receive('notify_status_update');owner.printer.print.gcode.coordinates.execute('M220',{S:150});const update=await reply;assert.equal(update.method,'notify_status_update');assert.deepEqual(update.params[0],{gcode_move:{speed_factor:1.5}});assert(update.params[1]>initial.result.eventtime);
  reply=receive('notify_status_update');owner.printer.print.gcode.display.setMessage('准备完成');owner.printer.print.gcode.display.updateProgress({P:'25'});const display=await reply;assert.deepEqual(display.params[0],{display_status:{message:'准备完成',progress:.25}});
  reply=receive();ws.send(JSON.stringify({jsonrpc:'2.0',id:2,method:'printer.objects.subscribe',params:{objects:{extruder:['pressure_advance','smooth_time']}}}));assert.deepEqual((await reply).result.status,{extruder:{pressure_advance:0,smooth_time:.04}});
  reply=receive('notify_status_update');owner.printer.print.gcode.enable();await owner.printer.print.gcode.dispatch.execute('SET_PRESSURE_ADVANCE ADVANCE=0 SMOOTH_TIME=0.12',{boundary:'checkpoint'});const pressureUpdate=await reply;assert.equal(pressureUpdate.method,'notify_status_update');assert.deepEqual(pressureUpdate.params[0],{extruder:{smooth_time:.12}});
  allowed=false;const closed=once(ws,'close',{signal:AbortSignal.timeout(3000)});await owner.printer.print.gcode.dispatch.execute('SET_PRESSURE_ADVANCE ADVANCE=0 SMOOTH_TIME=0.04',{boundary:'checkpoint'});await closed;assert(f.firmware.every(f=>f.motion.length===0));
 }finally{ws?.terminate();await owner?.close();await f.dispose();}
});
test('configured Z tilt HTTP calibration owns probe, motor adjustment and duplicate receipts',async()=>{
 const f=await fixture(),raw={...f.reader.source.original,probe:{pin:'^PA13',z_offset:'0'},stepper_z1:{step_pin:'PA14',dir_pin:'PA15',rotation_distance:'40',microsteps:'16',enable_pin:'!PA2'},z_tilt:{z_positions:'50,0\n50.01,0',points:'50,0\n50.01,0',horizontal_move_z:'1',speed:'10',max_adjust:'1'}},transport=await productTransports(new ConfigurationReader(new ConfigurationSource('/z-tilt.cfg',raw,[]),null));
 let owner:Awaited<ReturnType<typeof startConfiguredProductService>>|undefined,timer:ReturnType<typeof setInterval>|undefined;
 try{
  owner=await startConfiguredProductService(transport.reader,transport.policies,f.product,{...f.serviceOptions,machine:{enableLeadTime:.001,fanMinimumScheduleTime:.001},hardware:f.options.hardware,print:f.options.print},f.signal);
  const base=`http://127.0.0.1:${owner.address.port}`,path='/printer/calibration/z_tilt',headers={'x-api-key':'test','content-type':'application/json'};
  const state=await (await fetch(base+path,{headers})).json() as any,request={version:1,state_token:state.result.state_token};assert.equal(state.result.available,false);
  const post=()=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(request)});
  assert.equal((await post()).status,409);assert.equal((await fetch(base+path)).status,401);
  await owner.printer.print.gcode.dispatch.runExclusive(async signal=>{
   owner!.printer.linear.kinematics.markHomed([0,1,2]);await owner!.printer.linear.port.forcePosition([50,0,1,0],signal);owner!.printer.print.gcode.coordinates.resetPosition();
  },f.signal);
  const fw=transport.firmware[0],probe=owner.printer.hardware.plan.homing.find(h=>h.section==='probe')!,trigger=probe.triggers[0].protocol,handled=new Set<unknown>();let hits=0;
  timer=setInterval(()=>{
   const outputs=fw.outputs,arm=outputs.find(m=>m.name==='endstop_home'&&m.parameters.oid===probe.endstop.oid&&Number(m.parameters.sample_count)>0&&!handled.has(m));
   if(!arm){if(hits&&outputs.findLastIndex(m=>m.name==='reset_step_clock')>outputs.findLastIndex(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0))fw.setTriggerReason(2,trigger.oid);return;}
   const hit=Number(arm.parameters.clock)+50000;if(fw.currentClock()<hit+1000)return;handled.add(arm);hits++;fw.setTriggerReason(1,trigger.oid);fw.setEndstopState({homing:0,pin_value:0,next_clock:hit+Number(arm.parameters.rest_ticks)},probe.endstop.oid);fw.emit('trsync_state',{oid:trigger.oid,can_trigger:0,trigger_reason:1,clock:hit});
  },1);
  let receipt:any;
  // Join any admitted clock maintenance, then retain dispatch until the one
  // explicit calibration has returned. The endpoint keeps its idle guards.
  await owner.printer.print.gcode.dispatch.runExclusive(async signal=>{
   signal.throwIfAborted();assert.equal(owner!.printer.linear.port.status.busy,false);
   assert.equal(await owner!.printer.print.gcode.dispatch.runWhenIdle(async()=>assert.fail('Clock maintenance entered held calibration'),signal),false);
   const response=await post();receipt=await response.json();assert.equal(response.status,200,JSON.stringify(receipt));
  },f.signal);
  assert.equal(hits,2);assert.equal(receipt.result.result.passes,1);assert.equal(receipt.result.result.persisted,false);
  const motion=fw.motion.length,repeated=await post();assert.deepEqual(await repeated.json(),receipt);assert.equal(fw.motion.length,motion);assert.equal(hits,2);
  assert.deepEqual(owner.printer.print.gcode.coordinates.state.position,owner.printer.linear.port.position());
  const status=await (await fetch(base+'/printer/objects/query?z_tilt',{headers})).json() as any;assert.deepEqual(status.result.status.z_tilt,{applied:true});
 }finally{if(timer)clearInterval(timer);await owner?.close();await transport.close();await f.dispose();}
});
test('explicit product layout cannot advertise Z tilt without bound probe and motors',async()=>{
 const f=await fixture();
 try{
  const reader=new ConfigurationReader(new ConfigurationSource('/mismatch.cfg',{...f.reader.source.original,probe:{pin:'^PA13',z_offset:'0'},stepper_z1:{},z_tilt:{z_positions:'0,0\n100,0',points:'0,0\n100,0'}},[]),null);
  await assert.rejects(startProductService(reader,f.connections,'mcu',f.layout,f.options,f.product,f.serviceOptions,f.signal),/Z tilt hardware ownership/);assert.deepEqual(f.stops,[1,1]);
 }finally{await f.dispose();}
});
test('configured quad gantry HTTP calibration owns probe, motor adjustment and duplicate receipts',async()=>{
 const f=await fixture(),raw={...f.reader.source.original,probe:{pin:'^PA13',z_offset:'0'},stepper_z1:{step_pin:'PA14',dir_pin:'PA15',rotation_distance:'40',microsteps:'16',enable_pin:'!PA2'},stepper_z2:{step_pin:'PA16',dir_pin:'PA17',rotation_distance:'40',microsteps:'16',enable_pin:'!PA2'},stepper_z3:{step_pin:'PA18',dir_pin:'PA19',rotation_distance:'40',microsteps:'16',enable_pin:'!PA2'},quad_gantry_level:{gantry_corners:'50,0\n50.01,.01',points:'50,0\n50,.01\n50.01,.01\n50.01,0',horizontal_move_z:'1',speed:'10',max_adjust:'1'}},transport=await productTransports(new ConfigurationReader(new ConfigurationSource('/z-tilt.cfg',raw,[]),null));
 let owner:Awaited<ReturnType<typeof startConfiguredProductService>>|undefined,timer:ReturnType<typeof setInterval>|undefined;
 try{
  owner=await startConfiguredProductService(transport.reader,transport.policies,f.product,{...f.serviceOptions,machine:{enableLeadTime:.001,fanMinimumScheduleTime:.001},hardware:f.options.hardware,print:f.options.print},f.signal);
  const base=`http://127.0.0.1:${owner.address.port}`,path='/printer/calibration/quad_gantry_level',headers={'x-api-key':'test','content-type':'application/json'};
  const state=await (await fetch(base+path,{headers})).json() as any,request={version:1,state_token:state.result.state_token};assert.equal(state.result.available,false);
  const post=()=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(request)});
  assert.equal((await post()).status,409);assert.equal((await fetch(base+path)).status,401);
  await owner.printer.print.gcode.dispatch.runExclusive(async signal=>{
   owner!.printer.linear.kinematics.markHomed([0,1,2]);await owner!.printer.linear.port.forcePosition([50,0,1,0],signal);owner!.printer.print.gcode.coordinates.resetPosition();
  },f.signal);
  const fw=transport.firmware[0],probe=owner.printer.hardware.plan.homing.find(h=>h.section==='probe')!,trigger=probe.triggers[0].protocol,handled=new Set<unknown>();let hits=0;
  timer=setInterval(()=>{
   const outputs=fw.outputs,arm=outputs.find(m=>m.name==='endstop_home'&&m.parameters.oid===probe.endstop.oid&&Number(m.parameters.sample_count)>0&&!handled.has(m));
   if(!arm){if(hits&&outputs.findLastIndex(m=>m.name==='reset_step_clock')>outputs.findLastIndex(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0))fw.setTriggerReason(2,trigger.oid);return;}
   const hit=Number(arm.parameters.clock)+50000;if(fw.currentClock()<hit+1000)return;handled.add(arm);hits++;fw.setTriggerReason(1,trigger.oid);fw.setEndstopState({homing:0,pin_value:0,next_clock:hit+Number(arm.parameters.rest_ticks)},probe.endstop.oid);fw.emit('trsync_state',{oid:trigger.oid,can_trigger:0,trigger_reason:1,clock:hit});
  },1);
  let receipt:any;
  // Join any admitted clock maintenance, then retain dispatch until the one
  // explicit calibration has returned. The endpoint keeps its idle guards.
  await owner.printer.print.gcode.dispatch.runExclusive(async signal=>{
   signal.throwIfAborted();assert.equal(owner!.printer.linear.port.status.busy,false);
   assert.equal(await owner!.printer.print.gcode.dispatch.runWhenIdle(async()=>assert.fail('Clock maintenance entered held calibration'),signal),false);
   const response=await post();receipt=await response.json();assert.equal(response.status,200,JSON.stringify(receipt));
  },f.signal);
  assert.equal(hits,4);assert.equal(receipt.result.result.passes,1);assert.equal(receipt.result.result.persisted,false);
  const motion=fw.motion.length,repeated=await post();assert.deepEqual(await repeated.json(),receipt);assert.equal(fw.motion.length,motion);assert.equal(hits,4);
  assert.deepEqual(owner.printer.print.gcode.coordinates.state.position,owner.printer.linear.port.position());
  const status=await (await fetch(base+'/printer/objects/query?quad_gantry_level',{headers})).json() as any;assert.deepEqual(status.result.status.quad_gantry_level,{applied:true});
 }finally{if(timer)clearInterval(timer);await owner?.close();await transport.close();await f.dispose();}
});
test('skew HTTP persistence reloads exact server coefficients and fences previous service tokens',async t=>{
 const {KlipperSaveSession}=await import('../src/config/klipper-save-session.ts');
 const f=await fixture();let next:Awaited<ReturnType<typeof fixture>>|undefined,owner:Awaited<ReturnType<typeof startProductService>>|undefined;
 try{
  const path=join(f.dir,'printer.cfg'),sections={...f.reader.source.original,skew_correction:{}};
  await writeFile(path,Object.entries(sections).map(([name,values])=>'['+name+']\n'+Object.entries(values).map(([key,value])=>key+': '+String(value).replace(/\n/g,'\n  ')).join('\n')).join('\n\n'));
  const loaded=await KlipperSaveSession.load(path),reader=new ConfigurationReader(loaded.source,null);
  owner=await startProductService(reader,f.connections,'mcu',f.layout,f.options,{...f.product,configurationSession:loaded.session},f.serviceOptions,f.signal);
  let base=`http://127.0.0.1:${owner.address.port}`;const headers={'x-api-key':'test','content-type':'application/json'};
  const get=async(path:string)=>(await (await fetch(base+path,{headers})).json() as any).result;
  const post=async(path:string,body:unknown,authorized=true)=>{const response=await fetch(base+path,{method:'POST',headers:authorized?headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as any};};
  const settings='/printer/settings/skew',configuration='/printer/configuration/skew',state=await get(settings);
  const set={version:1,state_token:state.state_token,action:'measure',measurements:{xy:[142.123456789,141.987654321,100],xz:null,yz:null}};
  const stepCount=()=> (next??f).firmware.reduce((count,fw)=>count+fw.motion.filter(m=>m.name==='queue_step').length,0);
  // GET availability is a hint. Only an explicit pre-admission idle rejection
  // permits another POST with the original token. Preserve every busy guard.
  const postWhenIdle=async(endpoint:string,body:Record<string,unknown>)=>{
   const before=await get(endpoint),deadline=performance.now()+5000;let rejections=0;
   assert.equal(before.state_token,body.state_token);
   for(;;){
    const hint=await get(endpoint);assert.equal(hint.state_token,before.state_token);assert.deepEqual(hint.factors,before.factors);assert.equal(hint.state,before.state);
    assert.equal(owner!.printer.controller.state,'idle');assert.equal(owner!.printer.linear.port.status.failed,false);assert.equal(owner!.printer.linear.port.status.pendingMoves,0);
    assert(performance.now()<deadline,'Skew operation did not reach idle admission');
    if(!hint.available){await delay(2);continue;}
    const steps=stepCount(),configurationBefore=await readFile(path),response=await post(endpoint,body);
    if(response.status!==409){assert.equal(response.status,200,JSON.stringify(response));t.diagnostic(JSON.stringify({skewIdleAdmission:{endpoint,action:body.action,rejections,deadlineMs:5000,sameTokenUntilAccepted:true}}));return response;}
    const messages=endpoint===settings?['Skew settings require an idle printer','Printer activity blocks skew settings']:['Skew persistence requires idle printer and configuration session','Printer activity blocks skew persistence'];
    assert(messages.includes(response.body.error?.message),JSON.stringify(response));assert(++rejections<=16,'Unexpected repeated skew admission rejection');
    assert.equal(stepCount(),steps,'Rejected skew operation submitted motion');assert.deepEqual(await readFile(path),configurationBefore,'Rejected skew operation changed configuration');await delay(2);
   }
  };
  const release=f.product.maintenanceGate.acquire(),beforeBusy=await readFile(path),busySteps=stepCount();
  try{
   assert.equal((await get(settings)).available,false);const rejected=await post(settings,set);assert.equal(rejected.status,409);assert.equal(rejected.body.error.message,'Skew settings require an idle printer');
   const after=await get(settings);assert.equal(after.state_token,state.state_token);assert.deepEqual(after.factors,state.factors);assert.equal(stepCount(),busySteps);assert.deepEqual(await readFile(path),beforeBusy);
  }finally{release();}
  const measured=await postWhenIdle(settings,set);const factors=measured.body.result.factors;
  assert.deepEqual(owner.printer.print.gcode.coordinates.state.position,owner.printer.linear.port.position());
  const save={version:1,state_token:(await get(configuration)).state_token,action:'save',profile:'calibrated'};
  assert.equal((await post(configuration,save,false)).status,401);const receipt=await postWhenIdle(configuration,save);assert(receipt.body.result.restart_required);assert.deepEqual(await post(configuration,save),receipt);
  assert.equal((await post(settings,{version:1,state_token:(await get(settings)).state_token,action:'clear'})).status,409);assert(loaded.session.status.sealedForRestart);
  await owner.close();owner=undefined;next=await fixture();const restored=await KlipperSaveSession.load(path);
  owner=await startProductService(new ConfigurationReader(restored.source,null),next.connections,'mcu',next.layout,next.options,{...next.product,configurationSession:restored.session},next.serviceOptions,next.signal);base=`http://127.0.0.1:${owner.address.port}`;
  const current=await get(settings);assert.deepEqual(current.factors,{xy:0,xz:0,yz:0});assert.deepEqual(current.profiles,['calibrated']);assert.equal((await post(settings,set)).status,409);assert.equal((await post(configuration,save)).status,409);
  const activated=await postWhenIdle(settings,{version:1,state_token:current.state_token,action:'load',profile:'calibrated'});assert.deepEqual(activated.body.result.factors,factors);
  const remove=await postWhenIdle(configuration,{version:1,state_token:(await get(configuration)).state_token,action:'remove',profile:'calibrated'});const deleted=await KlipperSaveSession.load(path);assert.equal(deleted.source.original['skew_correction calibrated'],undefined);
 }finally{await owner?.close();await next?.dispose();await f.dispose();}
});
test('native dispatch responses enter authorized console history and detach on service close',async()=>{
 const f=await fixture();let owner:Awaited<ReturnType<typeof startProductService>>|undefined,ws:WebSocket|undefined;
 f.serviceOptions.server.authorizeNotification=()=>{};
 try{
  await writeFile(f.serviceOptions.configPath,'[server]\nhost=127.0.0.1\nport=0\n[data_store]\ngcode_store_size=2');
  owner=await startProductService(f.reader,f.connections,'mcu',f.layout,f.options,f.product,f.serviceOptions,f.signal);
  const url=`http://127.0.0.1:${owner.address.port}/server/gcode_store`,dispatch=owner.printer.print.gcode.dispatch;
  const denied=await fetch(url);assert.equal(denied.status,401);await denied.arrayBuffer();
  ws=new WebSocket(`ws://127.0.0.1:${owner.address.port}/websocket`,{headers:{'x-api-key':'test'}});await once(ws,'open');
  const ready=once(ws,'message',{signal:AbortSignal.timeout(3000)});ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'server.info'}));await ready;
  const notifications:string[]=[];ws.on('message',data=>{const message=JSON.parse(String(data));if(message.method==='notify_gcode_response')notifications.push(message.params[0]);});
  dispatch.register('REPORT_CONSOLE',c=>{c.respondInfo('first');c.respondRaw('second');c.respondRaw('third');});
  dispatch.setReady(true);await dispatch.execute('REPORT_CONSOLE');
  const response=await fetch(url,{headers:{'x-api-key':'test'}});assert.equal(response.status,200);
  const rows=(await response.json()).result.gcode_store;assert.deepEqual(rows.map((row:{message:string;type:string})=>[row.message,row.type]),[['second','response'],['third','response']]);assert(rows.every((row:{time:number})=>Number.isFinite(row.time)&&row.time>0));
  for(let i=0;i<100&&notifications.length<3;i++)await delay(10);assert.deepEqual(notifications,['// first','second','third']);
  assert.equal(owner.server.gcodeStoreStatus?.records,2);assert.equal(dispatch.outputObservation.listeners,1);ws.terminate();await owner.close();assert.equal(dispatch.outputObservation.listeners,0);
  owner.server.recordNativeGcodeResponse('late');assert.equal(owner.server.gcodeStoreStatus?.records,2);
 }finally{ws?.terminate();await owner?.close();await f.dispose();}
});
test('native process statistics use real Linux values behind authorization and stop their sampler',async()=>{
 const f=await fixture();let owner:Awaited<ReturnType<typeof startProductService>>|undefined,ws:WebSocket|undefined;
 f.serviceOptions.server.authorizeNotification=()=>{};
 try{
  owner=await startProductService(f.reader,f.connections,'mcu',f.layout,f.options,f.product,f.serviceOptions,f.signal);const url=`http://127.0.0.1:${owner.address.port}/machine/proc_stats`;
  const denied=await fetch(url);assert.equal(denied.status,401);await denied.arrayBuffer();
  ws=new WebSocket(url.replace('http:','ws:').replace('/machine/proc_stats','/websocket'),{headers:{'x-api-key':'test'}});await once(ws,'open');
  const ready=once(ws,'message',{signal:AbortSignal.timeout(3000)});ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'machine.proc_stats'}));const [rpc]=await ready;assert(Array.isArray(JSON.parse(String(rpc)).result.moonraker_stats));
  const notification=new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Process notification timeout')),3000);ws!.on('message',data=>{const message=JSON.parse(String(data));if(message.method==='notify_proc_stat_update'){clearTimeout(timer);resolve(message.params[0]);}});});
  const event=await notification;assert(!Array.isArray(event.moonraker_stats));assert(Number.isFinite(event.moonraker_stats.cpu_usage));assert.equal(event.websocket_connections,1);
  for(let i=0;i<200&&!owner.server.procStatsStatus?.samples;i++)await delay(10);
  const response=await fetch(url,{headers:{'x-api-key':'test'}});assert.equal(response.status,200);const value=(await response.json()).result;
  assert(value.moonraker_stats.length>0&&value.moonraker_stats.length<=30);assert(value.system_uptime>0);assert.equal(value.websocket_connections,1);assert(value.system_memory.total>0);assert.equal(value.moonraker_stats[0].mem_units,'kB');assert(value.moonraker_stats[0].memory>0);await owner.close();assert.equal(owner.server.procStatsStatus?.closed,true);assert.equal(owner.server.procStatsStatus?.pending,false);
 }finally{ws?.terminate();await owner?.close();await f.dispose();}
});
test('native system information is initialized before listening and authorized over HTTP and RPC',async()=>{
 const f=await fixture();let owner:Awaited<ReturnType<typeof startProductService>>|undefined,ws:WebSocket|undefined;
 try{
  owner=await startProductService(f.reader,f.connections,'mcu',f.layout,f.options,f.product,f.serviceOptions,f.signal);const base=`http://127.0.0.1:${owner.address.port}`;
  const denied=await fetch(base+'/machine/system_info');assert.equal(denied.status,401);await denied.arrayBuffer();
  const response=await fetch(base+'/machine/system_info',{headers:{'x-api-key':'test'}});assert.equal(response.status,200);const value=(await response.json()).result.system_info;
  assert.equal(value.runtime.name,'node');assert.equal(value.runtime.version,process.version);assert.equal(value.python,undefined);assert(value.cpu_info.cpu_count>0);assert(value.cpu_info.total_memory>0);assert(['none','systemd_cli'].includes(value.provider));assert(Array.isArray(value.available_services));assert.deepEqual(Object.keys(value.service_state),value.available_services);assert(owner.server.systemServicesStatus);assert.equal(owner.server.systemServicesStatus.pending,false);
  ws=new WebSocket(base.replace('http:','ws:')+'/websocket',{headers:{'x-api-key':'test'}});await once(ws,'open');const received=once(ws,'message',{signal:AbortSignal.timeout(3000)});ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'machine.system_info'}));const [message]=await received;assert.deepEqual(JSON.parse(String(message)).result.system_info,value);
  ws.terminate();await owner.close();assert.equal(owner.server.systemInformationStatus?.closed,true);assert.equal(owner.server.systemInformationStatus?.pending,false);assert.equal(owner.server.systemServicesStatus?.closed,true);assert.equal(owner.server.systemServicesStatus?.pending,false);
 }finally{ws?.terminate();await owner?.close();await f.dispose();}
});
