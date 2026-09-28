import {startDeltaProductService,startConfiguredDeltaProductService} from '../src/runtime/product-service.ts';
import {productTransports} from './helpers/product-transports.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {initialMotionSetup} from './helpers/initial-motion.ts';
import {deltaPrinterSections} from './helpers/delta-printer.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {planDeltaPrinter} from '../src/config/delta-printer.ts';
import {connectDeltaProductPrinter} from '../src/runtime/product-delta-printer.ts';
import type {ConfiguredDeltaPrinterOptions} from '../src/runtime/configured-delta-printer.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
const request={version:1 as const,requestId:'delta-job',fileId:'file',nozzle:200,bed:60};
async function fixture(){
 const f=await initialMotionSetup(false,true,true,false),dir=await mkdtemp('/tmp/delta-product-');
 const journal=await PrintJournal.open({path:dir+'/jobs.db',deviceId:'delta'}),maintenanceGate=new MaintenanceGate();
 const raw=deltaPrinterSections(f.reader.source.original);Object.assign(raw.stepper_a,{homing_retract_dist:'.2',homing_speed:'40',second_homing_speed:'10'});
 const reader=new ConfigurationReader(new ConfigurationSource('/delta.cfg',raw,[]),null),plan=planDeltaPrinter(reader,{mcus:['mcu','aux'],enableLeadTime:.001,fanMinimumScheduleTime:.001});
 await writeFile(dir+'/job.gcode','G1 X0 Y0 Z299 E0.1 F600\n');
 const options:ConfiguredDeltaPrinterOptions={hardware:{...f.hardwareOptions,motion:plan.motion},motion:plan.initial,delta:plan.delta,print:{output(){},motorCompletion:'hold',startupHoming:{mode:'home',axes:[0,1,2]},parking:{parkXY:[0,0],retract:0,lift:0,travelSpeed:10,liftSpeed:5,retractSpeed:5},lifecycle:{prepare:async()=>{},start:async()=>{},finishOutputs:async()=>{},stopOutputs:async()=>{}},open:async()=>GCodeFileReader.adopt(await open(dir+'/job.gcode','r'))}};
 return {...f,reader,plan,options,dir,journal,maintenanceGate,product:{journal,maintenanceGate,limits:{maxNozzle:300,maxBed:130}},async dispose(){await f.close();await journal.close();await rm(dir,{recursive:true,force:true});}};
}
function simulate(f:Awaited<ReturnType<typeof fixture>>,owner:Awaited<ReturnType<typeof connectDeltaProductPrinter>>){
 const cursor=[0,0],passes=new Map<string,number>(),timers:ReturnType<typeof setTimeout>[]=[];
 const seek=owner.delta.port.home.bind(owner.delta.port);
 owner.delta.port.home=async(...args)=>{const pass=await seek(...args);for(const h of owner.hardware.plan.homing)for(const t of h.triggers)f.firmware[t.mcu==='mcu'?0:1].setTriggerReason(2,t.protocol.oid);return pass;};
 const timer=setInterval(()=>{
  for(const [i,plan] of owner.hardware.plan.heaters.entries()){
   const session=owner.group.session(plan.sensor.mcu),raw=Math.round(plan.configuration.converter.adc(i?80:220)*plan.sensor.adc.maximumSum),next=session.clock.sync.getClock(serialClock.now())+292000n;
   f.firmware[plan.sensor.mcu==='mcu'?0:1].emit('analog_in_state',{oid:plan.sensor.adc.oid,next_clock:Number(BigInt.asUintN(32,next)),values:Buffer.from([raw&255,raw>>8])});
  }
  for(const [i,fw] of f.firmware.entries())for(const output of fw.outputs.slice(cursor[i])){
   if(output.name!=='endstop_home'||Number(output.parameters.sample_count)===0)continue;
   const h=owner.hardware.plan.homing.find(h=>h.mcu===(i===0?'mcu':'aux')&&h.endstop.oid===Number(output.parameters.oid));if(!h)continue;
   const tower=h.section.slice(8),pass=(passes.get(tower)??0)+1;passes.set(tower,pass);
   const motor=owner.initial.generation.motion.bindings.find(b=>b.id===tower)!,count=Number(owner.initial.stopped.positions.find(p=>p.member===motor.member&&p.oid===motor.oid)!.position)+pass*50;
   const hit=Number(output.parameters.clock)+(pass===1?50000:15000)+['a','b','c'].indexOf(tower)*4000,trigger=h.triggers.find(t=>t.mcu===h.mcu)!.protocol;
   timers.push(setTimeout(()=>{fw.setStepperPosition(motor.oid,count);fw.setTriggerReason(1,trigger.oid);fw.setEndstopState({homing:0,pin_value:0,next_clock:hit+Number(output.parameters.rest_ticks)},h.endstop.oid);fw.emit('trsync_state',{oid:trigger.oid,can_trigger:0,trigger_reason:1,clock:hit});},Math.max(0,(hit-fw.currentClock())/1000+10)));
  }
  for(let i=0;i<2;i++)cursor[i]=f.firmware[i].outputs.length;
 },5);
 return {passes,close(){clearInterval(timer);for(const timer of timers)clearTimeout(timer);}};
}
const benchmark=!!process.env.DELTA_PRODUCT_BENCH;
for(let run=0;run<(benchmark?4:1);run++)for(const loaded of (benchmark?(run%2?[true,false]:[false,true]):[false]))test(`Delta Moonraker start completes heated extrusion before publishing durable completion (run=${run}, loaded=${loaded})`,async t=>{
 const f=await fixture();let owner:Awaited<ReturnType<typeof connectDeltaProductPrinter>>|undefined,simulation:ReturnType<typeof simulate>|undefined,server:ConfiguredMoonraker|undefined;
 let polling=false,poller:Promise<void>|undefined;const latencies:number[]=[];
 const watch=new AbortController();let service:Awaited<ReturnType<typeof startDeltaProductService>>|undefined;
 try{
  const path=f.dir+'/moonraker.conf';await writeFile(path,'[server]\nhost=127.0.0.1\nport=0\n');
  service=await startDeltaProductService(f.reader,f.connections,'mcu',f.plan.layout,f.options,f.product,{configPath:path,server:{information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize:()=>{}}},f.signal);
  owner=service.printer;const printer=owner;simulation=simulate(f,printer);server=service.server;
  const address=service.address,states=printer.controller.watchState(AbortSignal.any([watch.signal,AbortSignal.timeout(10000)]));
  const before=await fetch(`http://127.0.0.1:${address.port}/printer/objects/query?toolhead`);assert.equal(before.status,200);assert.equal((await before.json() as any).result.status.toolhead.homed_axes,'');
  const done=(async()=>{for await(const change of states){if(change.state==='failed')throw printer.controller.failure;if(change.state==='completed')return;}throw new Error('Completion not observed');})();void done.catch(()=>{});
  polling=loaded;
  if(loaded){poller=(async()=>{while(polling){const start=performance.now(),response=await fetch(`http://127.0.0.1:${address.port}/printer/objects/query?toolhead&extruder&heater_bed&print_stats`);assert.equal(response.status,200);await response.arrayBuffer();latencies.push(performance.now()-start);}})();void poller.catch(()=>{});}
  const start=performance.now(),cpu=process.cpuUsage();
  const response=await fetch(`http://127.0.0.1:${address.port}/printer/print/start`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:1,request_id:request.requestId,file_id:request.fileId,nozzle:200,bed:60,expires_at:Date.now()+10000})});assert.equal(response.status,200);await response.arrayBuffer();await done;
  polling=false;await poller;const used=process.cpuUsage(cpu);if(benchmark){latencies.sort((a,b)=>a-b);t.diagnostic('DeltaProductBenchmark '+JSON.stringify({run,loaded,wallMs:performance.now()-start,cpuMs:(used.user+used.system)/1000,queries:latencies.length,queryP99Ms:latencies.length?latencies[Math.min(latencies.length-1,Math.floor(latencies.length*.99))]:null}));}
  assert.deepEqual([...simulation.passes.values()],[2,2,2]);assert.equal((await f.journal.get(request.requestId))?.state,'completed');assert.equal(printer.print.file.status.file?.closed,true);
  assert.deepEqual(printer.delta.port.position(),[0,0,299,.1]);const oid=printer.hardware.plan.steppers.find(s=>s.emitter==='e')!.compressor.oid;
  assert.equal(f.firmware[0].motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===oid).reduce((n,m)=>n+Number(m.parameters.count),0),8);
  for(const binding of printer.hardware.analog){assert.equal(binding.runtime.status.target,0);assert.equal(binding.outputStatus?.defaultConfirmed,true);}
  assert.equal(printer.controller.state,'completed');assert.equal(printer.delta.port.status.failed,false);
  simulation.close();simulation=undefined;await server.close();await printer.close();assert.deepEqual(f.stops,[1,1]);assert.equal(printer.delta.kinematics.status.homedAxes,'');
 }finally{polling=false;await poller?.catch(()=>{});watch.abort();simulation?.close();await service?.close();await server?.close();await owner?.close();await f.dispose();}
});
test('Delta refuses a live reserved journal without replay and closes acquired hardware',async()=>{
 const f=await fixture();try{await f.journal.reserve(request);await assert.rejects(connectDeltaProductPrinter(f.reader,f.connections,'mcu',f.plan.layout,f.options,f.product,f.signal),/live print journal/);assert.deepEqual(f.stops,[1,1]);assert(f.firmware.every(f=>f.motion.length===0));assert.equal(f.maintenanceGate.status.closed,true);assert.equal((await f.journal.get(request.requestId))?.state,'reserved');}finally{await f.dispose();}
});
test('Delta product close joins delayed preparation before persisting cancellation',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let owner:Awaited<ReturnType<typeof connectDeltaProductPrinter>>|undefined,closing:Promise<void>|undefined;
 f.options.print.lifecycle.prepare=async()=>{entered.resolve();await release.promise;};
 try{
  owner=await connectDeltaProductPrinter(f.reader,f.connections,'mcu',f.plan.layout,f.options,{...f.product,deadlines:{stopMs:10}},f.signal);
  const failed=assert.rejects(owner.controller.start(request));await entered.promise;let settled=false;closing=owner.close().finally(()=>settled=true);await failed;await new Promise(r=>setTimeout(r,30));assert.equal(settled,false);assert.equal((await f.journal.get(request.requestId))?.state,'reserved');release.resolve();await closing;
  assert.equal((await f.journal.get(request.requestId))?.state,'cancelled');assert.equal(owner.controller.pendingDeviceActions,0);assert.deepEqual(f.stops,[1,1]);assert(f.firmware.every(f=>f.motion.length===0));
 }finally{release.resolve();await closing?.catch(()=>{});await owner?.close().catch(()=>{});await f.dispose();}
});
test('configuration-driven Delta service opens UARTs, reports native status and enforces authorization',async()=>{
 const f=await fixture(),transport=await productTransports(f.reader);let service:Awaited<ReturnType<typeof startConfiguredDeltaProductService>>|undefined;
 try{
  const configPath=f.dir+'/auto.conf';await writeFile(configPath,'[server]\nhost=127.0.0.1\nport=0\n');
  service=await startConfiguredDeltaProductService(transport.reader,transport.policies,f.product,{configPath,machine:{enableLeadTime:.001,fanMinimumScheduleTime:.001},print:f.options.print,server:{information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize:(_method,_params,context)=>{if(context.request.headers['x-api-key']!=='test')throw new ApiError(401,'Denied');}}},f.signal);
  const url=`http://127.0.0.1:${service.address.port}/printer/objects/query?toolhead&native_host`;
  const denied=await fetch(url);assert.equal(denied.status,401);await denied.arrayBuffer();
  const response=await fetch(url,{headers:{'x-api-key':'test'}});assert.equal(response.status,200);const status=(await response.json() as any).result.status;
  assert.equal(status.toolhead.homed_axes,'');assert.deepEqual(status.toolhead.axis_maximum,[100,100,300,0]);assert.equal(status.native_host.hardware_state,'ready');assert.equal(service.printer.controller.durable,true);
  assert(transport.firmware.every(f=>f.motion.length===0));const closing=service.close();assert.equal(service.close(),closing);await closing;assert.deepEqual(transport.stops,[1,1]);assert.equal(f.maintenanceGate.status.closed,true);await assert.rejects(fetch(url));
 }finally{await service?.close();await transport.close();await f.dispose();}
});
