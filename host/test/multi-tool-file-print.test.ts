import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {configuredPrinterFixture} from './helpers/configured-printer.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {planLinearPrinter} from '../src/config/linear-printer.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {initializeConfiguredMotion} from '../src/runtime/initial-motion.ts';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
for(const mode of ['eof','mid','fault'] as const)for(const reverse of [false,true])test(`configured multi-tool sealed file lifecycle: mode=${mode}, reverse=${reverse}`,{timeout:30000},async()=>{
 const f=await configuredPrinterFixture(reverse),dir=await mkdtemp(join(tmpdir(),'multi-file-')),path=join(dir,'job.gcode');
 let hardware:Awaited<ReturnType<typeof startConfiguredHardware>>|undefined,owner:Awaited<ReturnType<ReturnType<Awaited<ReturnType<typeof initializeConfiguredMotion>>['createLinearPort']>['createPrint']>>|undefined,timer:ReturnType<typeof setInterval>|undefined;
 try{
  const original=f.reader.source.original,reader=new ConfigurationReader(new ConfigurationSource('/multi.cfg',{...original,exclude_object:{},extruder1:{...original.extruder,step_pin:'aux:PA6',dir_pin:'aux:PA7',enable_pin:'!aux:PA8',heater_pin:'aux:PA9',sensor_pin:'aux:PA10'}},[]),null);
  const plan=planLinearPrinter(reader,{mcus:['mcu','aux'],enableLeadTime:.001,fanMinimumScheduleTime:.001});
  hardware=await startConfiguredHardware(reader,f.group,f.clocks,plan.layout,{...f.options.hardware,motion:plan.motion},f.signal);
  const initial=await initializeConfiguredMotion(hardware,plan.initial,f.signal),machine=initial.createLinearPort(reader,plan.linear);
  // This fixture starts homed; separate native trigger tests cover actual G28.
  machine.kinematics.markHomed([0,1,2]);
  let invalidADC=false;
  const emit=()=>{for(const h of hardware!.plan.heaters){const temperature=h.section==='heater_bed'?60:200,raw=invalidADC&&h.section==='extruder1'?0:Math.round(h.configuration.converter.adc(temperature)*h.sensor.adc.maximumSum),next=f.group.session('aux').clock.sync.getClock(serialClock.now())+292000n;f.firmware[1].emit('analog_in_state',{oid:h.sensor.adc.oid,next_clock:Number(BigInt.asUintN(32,next)),values:Buffer.from([raw&255,raw>>8])});}};
  emit();timer=setInterval(emit,20);
  const script='M109 T1 S200\nM83\nEXCLUDE_OBJECT NAME=skip\nG1 E0.0125 F300\nG1 E0.0125\nG1 E0.0125\nG1 E0.0125\nG1 E0.0125\nEXCLUDE_OBJECT_START NAME=skip\nG1 E0.125\nT1\nG1 E0.25\nEXCLUDE_OBJECT_END\nG1 E0.025\nTEST_FILE_GATE\nT0\nG1 E0.025\nT1\n';
  await writeFile(path,mode==='eof'?script.replace('TEST_FILE_GATE\n',''):script);
  let finished=0;
  owner=await machine.createPrint({...f.options.print,startupHoming:{mode:'require_homed',axes:[0,1,2]},parking:{...f.options.print.parking,retract:.05},lifecycle:{...f.options.print.lifecycle,finishOutputs:async()=>{finished++;}},open:async()=>GCodeFileReader.adopt(await open(path,'r'))});
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),fault=Promise.withResolvers<unknown>();
  owner.gcode.dispatch.register('TEST_FILE_GATE',async c=>{entered.resolve();await Promise.race([release.promise,new Promise<never>((_,reject)=>{if(c.signal.aborted)reject(c.signal.reason);else c.signal.addEventListener('abort',()=>reject(c.signal.reason),{once:true});})]);});
  const eof=Promise.withResolvers<void>();void eof.promise.catch(()=>{});owner.device.subscribeEOF(()=>eof.resolve());owner.device.subscribeFault(e=>{fault.resolve(e);eof.reject(e);});
  await owner.device.prepare({version:1,requestId:'multi',fileId:'file',nozzle:200,bed:60},f.signal);
  assert.equal(hardware.heaters.getTemperature('extruder1').target,0);
  const counts=()=>f.firmware.map(fw=>fw.motion.filter(m=>m.name==='queue_step').reduce((n,m)=>n+Number(m.parameters.count),0));
  await owner.device.start('file',f.signal);
  if(mode!=='eof'){
   await entered.promise;assert.equal(owner.gcode.tools!.active,1);
   if(mode==='fault'){
    clearInterval(timer);timer=undefined;invalidADC=true;emit();await fault.promise;await owner.device.stop();
    assert(owner.device.status.fault);assert.equal(machine.port.status.failed,true);assert.equal(owner.file.status.file?.closed,true);assert.equal(finished,0);
    const stopped=counts();await delay(50);assert.deepEqual(counts(),stopped);
    for(const name of ['extruder','extruder1','heater_bed'])assert.equal(hardware.heaters.getTemperature(name).target,0);
    await assert.rejects(owner.device.resume(f.signal));await assert.rejects(owner.gcode.dispatch.execute('T0\nG1 E1'));
    return;
   }
   const pausing=owner.device.pause(f.signal);release.resolve();await pausing;
   assert.equal(owner.file.status.file?.phase,'paused');assert.deepEqual(counts(),[5,6]);
   await delay(30);assert.deepEqual(counts(),[5,6]);await owner.device.resume(f.signal);
  }
  await eof.promise;
  assert.equal(owner.gcode.tools!.active,1);assert.equal(hardware.heaters.getTemperature('extruder1').target,200);
  assert(Math.abs(machine.port.position()[3]-.0875)<1e-12);assert(Math.abs(machine.port.position()[4]-.025)<1e-12);
  await machine.port.drain(f.signal);
  assert.deepEqual(counts(),mode==='mid'?[7,10]:[7,2]);
  if(mode==='eof'){await owner.device.pause(f.signal);assert.deepEqual(counts(),[7,6]);await owner.device.resume(f.signal);assert.deepEqual(counts(),[7,10]);}
  await owner.device.finish('multi',f.signal);assert.equal(finished,1);assert.equal(owner.gcode.tools!.hasObjectExclusion,false);
  for(const name of ['extruder','extruder1','heater_bed'])assert.equal(hardware.heaters.getTemperature(name).target,0);
  assert.equal(owner.device.status.requestId,undefined);assert.equal(machine.port.status.failed,false);
 }finally{if(timer)clearInterval(timer);await owner?.close();await hardware?.close();await f.close();await rm(dir,{recursive:true,force:true});}
});
