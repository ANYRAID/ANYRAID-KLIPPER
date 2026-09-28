import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configuredPrinterFixture} from './helpers/configured-printer.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {planLinearPrinter} from '../src/config/linear-printer.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {initializeConfiguredMotion} from '../src/runtime/initial-motion.ts';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
for(const reverse of [false,true])test(`configured multi-tool sealed file heats, filters extrusion, parks selected tool and finishes: reverse=${reverse}`,{timeout:30000},async()=>{
 const f=await configuredPrinterFixture(reverse),dir=await mkdtemp(join(tmpdir(),'multi-file-')),path=join(dir,'job.gcode');
 let hardware:Awaited<ReturnType<typeof startConfiguredHardware>>|undefined,owner:Awaited<ReturnType<ReturnType<Awaited<ReturnType<typeof initializeConfiguredMotion>>['createLinearPort']>['createPrint']>>|undefined,timer:ReturnType<typeof setInterval>|undefined;
 try{
  const original=f.reader.source.original,reader=new ConfigurationReader(new ConfigurationSource('/multi.cfg',{...original,exclude_object:{},extruder1:{...original.extruder,step_pin:'aux:PA6',dir_pin:'aux:PA7',enable_pin:'!aux:PA8',heater_pin:'aux:PA9',sensor_pin:'aux:PA10'}},[]),null);
  const plan=planLinearPrinter(reader,{mcus:['mcu','aux'],enableLeadTime:.001,fanMinimumScheduleTime:.001});
  hardware=await startConfiguredHardware(reader,f.group,f.clocks,plan.layout,{...f.options.hardware,motion:plan.motion},f.signal);
  const initial=await initializeConfiguredMotion(hardware,plan.initial,f.signal),machine=initial.createLinearPort(reader,plan.linear);
  // This fixture starts homed; separate native trigger tests cover actual G28.
  machine.kinematics.markHomed([0,1,2]);
  const emit=()=>{for(const h of hardware!.plan.heaters){const temperature=h.section==='heater_bed'?60:200,raw=Math.round(h.configuration.converter.adc(temperature)*h.sensor.adc.maximumSum),next=f.group.session('aux').clock.sync.getClock(serialClock.now())+292000n;f.firmware[1].emit('analog_in_state',{oid:h.sensor.adc.oid,next_clock:Number(BigInt.asUintN(32,next)),values:Buffer.from([raw&255,raw>>8])});}};
  emit();timer=setInterval(emit,20);
  await writeFile(path,'M109 T1 S200\nM83\nEXCLUDE_OBJECT NAME=skip\nG1 E0.0125 F300\nG1 E0.0125\nG1 E0.0125\nG1 E0.0125\nG1 E0.0125\nEXCLUDE_OBJECT_START NAME=skip\nG1 E0.125\nT1\nG1 E0.25\nEXCLUDE_OBJECT_END\nG1 E0.025\nT0\nG1 E0.025\nT1\n');
  let finished=0;
  owner=await machine.createPrint({...f.options.print,startupHoming:{mode:'require_homed',axes:[0,1,2]},parking:{...f.options.print.parking,retract:.05},lifecycle:{...f.options.print.lifecycle,finishOutputs:async()=>{finished++;}},open:async()=>GCodeFileReader.adopt(await open(path,'r'))});
  const eof=Promise.withResolvers<void>();owner.device.subscribeEOF(()=>eof.resolve());owner.device.subscribeFault(e=>eof.reject(e));
  await owner.device.prepare({version:1,requestId:'multi',fileId:'file',nozzle:200,bed:60},f.signal);
  assert.equal(hardware.heaters.getTemperature('extruder1').target,0);
  await owner.device.start('file',f.signal);await eof.promise;
  assert.equal(owner.gcode.tools!.active,1);assert.equal(hardware.heaters.getTemperature('extruder1').target,200);
  assert(Math.abs(machine.port.position()[3]-.0875)<1e-12);assert(Math.abs(machine.port.position()[4]-.025)<1e-12);
  await machine.port.drain(f.signal);
  const counts=()=>f.firmware.map(fw=>fw.motion.filter(m=>m.name==='queue_step').reduce((n,m)=>n+Number(m.parameters.count),0));
  assert.deepEqual(counts(),[7,2]);
  // Pause at EOF still owns the file and validates parking/thermal restoration
  // before final drain. Mid-file pause is a separate product acceptance gate.
  await owner.device.pause(f.signal);assert.deepEqual(counts(),[7,6]);
  await owner.device.resume(f.signal);assert.deepEqual(counts(),[7,10]);
  await owner.device.finish('multi',f.signal);assert.equal(finished,1);assert.equal(owner.gcode.tools!.hasObjectExclusion,false);
  for(const name of ['extruder','extruder1','heater_bed'])assert.equal(hardware.heaters.getTemperature(name).target,0);
  assert.equal(owner.device.status.requestId,undefined);assert.equal(machine.port.status.failed,false);
 }finally{if(timer)clearInterval(timer);await owner?.close();await hardware?.close();await f.close();await rm(dir,{recursive:true,force:true});}
});
