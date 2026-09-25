import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initialLinearFixture} from './helpers/initial-linear.ts';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import type {ConfiguredPrintOptions} from '../src/runtime/initial-motion.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
const request={version:1 as const,requestId:'configured-job',fileId:'file',nozzle:200,bed:60};
const assemblyOptions=():ConfiguredPrintOptions=>({output(){},motorCompletion:'hold',startupHoming:{mode:'require_homed',axes:[0,1,2]},parking:{parkXY:[0,0],retract:0,lift:0,travelSpeed:10,liftSpeed:5,retractSpeed:5},lifecycle:{prepare:async()=>{},start:async()=>{},finishOutputs:async()=>{},stopOutputs:async()=>{}},open:async()=>{throw new Error('Unexpected file open');}});
test('configured arc resolution reaches the native print owner without consuming a failed handoff',async()=>{
 const f=await initialLinearFixture(false,true);try{
  const reader=(resolution:string)=>new ConfigurationReader(new ConfigurationSource('/arc.cfg',{...f.reader.source.original,gcode_arcs:{resolution}},[]),null);
  assert.throws(()=>f.initial.createLinearPort(reader('0'),f.settings));assert.deepEqual(f.stops,[0,0]);
  const linear=f.initial.createLinearPort(reader('.25'),f.settings),owner=await linear.createPrint(assemblyOptions());linear.kinematics.markHomed([0,1,2]);owner.gcode.enable();
  const coordinates=owner.gcode.coordinates,execute=coordinates.execute.bind(coordinates);let segments=0;coordinates.execute=(command,params)=>{if(command==='G1')segments++;execute(command,params);};
  await owner.gcode.dispatch.execute('G2 X2 I1 F600');assert.equal(segments,12);assert.deepEqual(coordinates.state.position,[2,0,0,0]);assert.equal(linear.port.status.failed,false);await owner.close();
 }finally{await f.hardware.close();await f.close();}
});
for(const interrupt of [false,true])test(`configured hardware owns ADC heaters and file lifetime (interrupt=${interrupt})`,async()=>{
 const f=await initialLinearFixture(true,true),dir=await mkdtemp(join(tmpdir(),'configured-print-')),path=join(dir,'job.gcode');let timer:ReturnType<typeof setInterval>|undefined,finished=0,stopped=0;
 try{
  await writeFile(path,interrupt?'WAIT\nG1 X1 E0.1 F600\n':'M105\nG1 X1 E0.1 F600\n');const linear=f.initial.createLinearPort(f.reader,f.settings),reports:string[]=[],h=f.hardware.plan.homing[0];let triggered=false;
  timer=setInterval(()=>{
   for(const [i,plan] of f.hardware.plan.heaters.entries()){
    const session=f.initial.generation.clockMembers.find(m=>m.mcu===plan.sensor.mcu)!.session,raw=Math.round(plan.configuration.converter.adc(i?80:220)*plan.sensor.adc.maximumSum),next=session.clock.sync.getClock(serialClock.now())+292000n;
    f.firmware[1].emit('analog_in_state',{oid:plan.sensor.adc.oid,next_clock:Number(BigInt.asUintN(32,next)),values:Buffer.from([raw&255,raw>>8])});
   }
   const arm=f.firmware[0].outputs.find(o=>o.name==='endstop_home'&&Number(o.parameters.sample_count)>0);if(!arm||triggered)return;
   const clock=BigInt(Number(arm.parameters.clock));if(f.initial.generation.members[0].session.clock.sync.getClock(serialClock.now())<clock)return;triggered=true;
   const oid=h.triggers[0].protocol.oid;f.firmware[0].setTriggerReason(1,oid);f.firmware[0].setEndstopState({homing:0,pin_value:0,next_clock:Number(clock)+Number(arm.parameters.rest_ticks)},h.endstop.oid);f.firmware[0].emit('trsync_state',{oid,can_trigger:0,trigger_reason:1,clock:Number(clock)});
  },20);
  const options:ConfiguredPrintOptions={output:m=>reports.push(m),motorCompletion:'hold',startupHoming:{mode:'home',axes:[0]},parking:{parkXY:[0,0],retract:0,lift:0,travelSpeed:10,liftSpeed:5,retractSpeed:5},lifecycle:{prepare:async()=>{},start:async()=>{},finishOutputs:async()=>{finished++;},stopOutputs:async()=>{stopped++;}},open:async id=>{assert.equal(id,'file');return GCodeFileReader.adopt(await open(path,'r'));}};
  const owner=await linear.createPrint(options);await assert.rejects(linear.createPrint(options),/owned/);const entered=Promise.withResolvers<void>();if(interrupt)owner.gcode.dispatch.register('WAIT',c=>new Promise<void>((resolve,reject)=>{c.signal.addEventListener('abort',()=>reject(c.signal.reason),{once:true});entered.resolve();}));
  const eof=Promise.withResolvers<void>();void eof.promise.catch(()=>{});owner.device.subscribeEOF(()=>eof.resolve());owner.device.subscribeFault(e=>eof.reject(e));
  await owner.device.prepare(request,f.signal);assert(triggered);assert.equal(linear.kinematics.status.homedAxes,'x');assert(f.hardware.analog[0].runtime.canExtrude());
  const before=f.firmware[0].motion.length;await owner.device.start('file',f.signal);
  if(interrupt){await entered.promise;clearInterval(timer);timer=undefined;await f.hardware.close();assert.equal(owner.file.status.file?.closed,true);assert.equal(finished,0);assert.equal(stopped,1);assert.equal(f.firmware[0].motion.length,before);assert.deepEqual(f.stops,[1,1]);for(const binding of f.hardware.analog)assert.equal(binding.runtime.status.target,0);return;}
  await eof.promise;await owner.device.finish(request.requestId,f.signal);
  const motion=f.firmware[0].motion.slice(before);for(const [id,steps] of [['x',80],['e',8]] as const){const oid=f.hardware.plan.steppers.find(s=>s.emitter===id)!.compressor.oid;assert.equal(motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===oid).reduce((n,m)=>n+Number(m.parameters.count),0),steps);}
  assert.equal(finished,1);assert.equal(stopped,0);assert.equal(owner.file.status.file?.closed,true);assert(reports.some(r=>r.includes('T:')&&r.includes('B:')));
  for(const binding of f.hardware.analog){assert.equal(binding.runtime.status.target,0);assert.equal(binding.outputStatus?.defaultConfirmed,true);}
  clearInterval(timer);timer=undefined;await f.hardware.close();assert.equal(linear.port.status.failed,true);assert.deepEqual(f.stops,[1,1]);
 }finally{if(timer)clearInterval(timer);await f.hardware.close();await f.close();await rm(dir,{recursive:true,force:true});}
});
test('missing configured print bed rejects before dispatch ownership',async()=>{
 const f=await initialLinearFixture();try{
  const linear=f.initial.createLinearPort(f.reader,f.settings);await assert.rejects(linear.createPrint(assemblyOptions()),/bed heater is missing/);assert.equal(linear.port.status.failed,false);assert.deepEqual(f.stops,[0,0]);assert.equal(f.hardware.heaters.status.closed,false);
 }finally{await f.hardware.close();await f.close();}
});
test('failed print assembly closes hardware and preserves the original error',async()=>{
 const f=await initialLinearFixture(false,true);let stops=0;try{
  const linear=f.initial.createLinearPort(f.reader,f.settings),options=assemblyOptions();options.parking.travelSpeed=0;options.lifecycle.stopOutputs=async()=>{stops++;};
  await assert.rejects(linear.createPrint(options),/parking configuration/);assert.equal(f.hardware.status.state,'stopped');assert.equal(linear.port.status.failed,true);assert.equal(f.hardware.heaters.status.closed,true);assert.deepEqual(f.stops,[1,1]);assert.equal(stops,1);
  for(const b of f.initial.generation.motion.bindings)assert.throws(()=>b.stepper.calibration,/closed/);
 }finally{await f.hardware.close();await f.close();}
});
