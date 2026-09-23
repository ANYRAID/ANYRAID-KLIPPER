import {GCodeFileReader} from '../src/gcode/file-reader.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configuredPrinterFixture} from './helpers/configured-printer.ts';
import {connectProductPrinter} from '../src/runtime/product-printer.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
const request={version:1 as const,requestId:'job',fileId:'file',nozzle:0,bed:0};
async function fixture(){const f=await configuredPrinterFixture(false,false),dir=await mkdtemp(join(tmpdir(),'product-printer-')),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'}),maintenanceGate=new MaintenanceGate();return {...f,dir,journal,maintenanceGate,product:{journal,maintenanceGate,limits:{maxNozzle:300,maxBed:130}},async dispose(){await f.close();await journal.close();await rm(dir,{recursive:true,force:true});}};}
for(const serviceFirst of [false,true])test('native HTTP admission closes active preparation; serviceFirst='+serviceFirst,async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>();let owner:Awaited<ReturnType<typeof connectProductPrinter>>|undefined,service:ConfiguredMoonraker|undefined;
 f.options.print.lifecycle.prepare=async(_request,signal)=>{entered.resolve();await new Promise<void>((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});if(signal.aborted)reject(signal.reason);});};
 try{
  const file=join(f.dir,'job.gcode');await writeFile(file,'G1 X1\n');f.options.print.open=async()=>GCodeFileReader.adopt(await open(file,'r'));
  owner=await connectProductPrinter(f.reader,f.connections,'mcu',f.layout,f.options,f.product,f.signal);
  const path=join(f.dir,'moonraker.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');
  service=await ConfiguredMoonraker.load(path,{productPrint:owner.controller,maintenanceGate:owner.maintenanceGate,information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize:()=>{}});
  const address=await service.start(),url=`http://127.0.0.1:${address.port}`;
  const response=await fetch(url+'/printer/print/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:1,request_id:'job',file_id:'file',nozzle:0,bed:0,expires_at:Date.now()+10000})});assert.equal(response.status,200);await response.arrayBuffer();await Promise.race([entered.promise,new Promise<never>((_resolve,reject)=>owner!.print.device.subscribeFault(reject)),new Promise<never>((_resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Preparation entry timeout')),5000);timer.unref();})]);
  assert.equal(owner.controller.state,'preparing');assert(await f.journal.get('job'));assert.equal(f.firmware[0].motion.length,0);
  if(serviceFirst)await service.close();await owner.close();await service.close();assert.deepEqual(f.stops,[1,1]);assert.equal(owner.maintenanceGate.status.closed,true);assert.equal((await f.journal.get('job'))?.state,'cancelled');await assert.rejects(owner.controller.start({...request,requestId:'late'}));
 }finally{await service?.close();await owner?.close();await f.dispose();}
});
test('failed durable restoration closes connected hardware without replay',async()=>{
 const f=await fixture();try{
  await f.journal.reserve(request);
  await assert.rejects(connectProductPrinter(f.reader,f.connections,'mcu',f.layout,f.options,f.product,f.signal),/live print journal/);assert.deepEqual(f.stops,[1,1]);assert.equal(f.firmware[0].motion.length,0);assert.equal(f.maintenanceGate.status.closed,true);assert.equal((await f.journal.get('job'))?.state,'reserved');
 }finally{await f.dispose();}
});
test('native product persists completion only after real motion and heater-off acknowledgements',async()=>{
 const f=await fixture(),watch=new AbortController();let owner:Awaited<ReturnType<typeof connectProductPrinter>>|undefined,timer:ReturnType<typeof setInterval>|undefined;
 try{
  const path=join(f.dir,'job.gcode');await writeFile(path,'G1 X1 E0.1 F600\n');f.options.print.open=async()=>GCodeFileReader.adopt(await open(path,'r'));f.options.print.startupHoming={mode:'home',axes:[0]};
  owner=await connectProductPrinter(f.reader,f.connections,'mcu',f.layout,f.options,f.product,f.signal);const printer=owner,h=printer.hardware.plan.homing[0];let triggered=false;
  timer=setInterval(()=>{
   for(const [i,plan] of printer.hardware.plan.heaters.entries()){
    const session=printer.group.session(plan.sensor.mcu),raw=Math.round(plan.configuration.converter.adc(i?80:220)*plan.sensor.adc.maximumSum),next=session.clock.sync.getClock(serialClock.now())+292000n;
    f.firmware[1].emit('analog_in_state',{oid:plan.sensor.adc.oid,next_clock:Number(BigInt.asUintN(32,next)),values:Buffer.from([raw&255,raw>>8])});
   }
   const arm=f.firmware[0].outputs.find(o=>o.name==='endstop_home'&&Number(o.parameters.sample_count)>0);if(!arm||triggered)return;
   const clock=BigInt(Number(arm.parameters.clock));if(printer.group.session('mcu').clock.sync.getClock(serialClock.now())<clock)return;triggered=true;
   const oid=h.triggers[0].protocol.oid;f.firmware[0].setTriggerReason(1,oid);f.firmware[0].setEndstopState({homing:0,pin_value:0,next_clock:Number(clock)+Number(arm.parameters.rest_ticks)},h.endstop.oid);f.firmware[0].emit('trsync_state',{oid,can_trigger:0,trigger_reason:1,clock:Number(clock)});
  },20);
  const stream=printer.controller.watchState(AbortSignal.any([watch.signal,AbortSignal.timeout(10000)]));
  const done=(async()=>{for await(const change of stream){if(change.state==='failed')throw printer.controller.failure;if(change.state==='completed')return;}throw new Error('Completion was not observed');})();void done.catch(()=>{});
  await printer.controller.start({...request,nozzle:200,bed:60}) ;await done;assert(triggered);
  assert.equal((await f.journal.get('job'))?.state,'completed');assert.equal(printer.print.file.status.file?.closed,true);
  // Homing uses X too; the final commanded position proves the print endpoint,
  // while extrusion has no homing pulses and must total exactly eight steps.
  assert.deepEqual(printer.linear.port.position(),[1,0,0,.1]);const oid=printer.hardware.plan.steppers.find(s=>s.emitter==='e')!.compressor.oid;
  assert.equal(f.firmware[0].motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===oid).reduce((n,m)=>n+Number(m.parameters.count),0),8);
  for(const binding of printer.hardware.analog){assert.equal(binding.runtime.status.target,0);assert.equal(binding.outputStatus?.defaultConfirmed,true);}
  clearInterval(timer);timer=undefined;await printer.close();
 }finally{watch.abort();if(timer)clearInterval(timer);await owner?.close();await f.dispose();}
});
