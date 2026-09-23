import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import {bindNativeFileMotion} from '../src/operations/native-file-motion.ts';
import {FilePrintDevice} from '../src/operations/file-print-device.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
for(const paused of [false,true])test(`independent MCU stop faults an idle file owner without another command (paused=${paused})`,async()=>{
 const t=await nativeLinearFixture(),dir=await mkdtemp(join(tmpdir(),'native-idle-fault-')),path=join(dir,'test.gcode'),cause=new Error('independent MCU failure');let outputStops=0;
 const motion=bindNativeFileMotion(t.port,{parkXY:[50,0],retract:0,lift:0,travelSpeed:10,liftSpeed:5,retractSpeed:5},{prepare:async()=>{},start:async()=>{},finishOutputs:async()=>{},stopOutputs:async()=>{outputStops++;}});
 const dispatch=new GCodeDispatch({output(){},shutdown:reason=>{void t.port.motorOff(new Error(reason));}}),device=new FilePrintDevice(motion,dispatch,async()=>GCodeFileReader.adopt(await open(path,'r')));
 try{
  t.kinematics.markHomed([0,1,2]);await writeFile(path,'G1 X51\n');await device.prepare({version:1,requestId:'job',fileId:'file',nozzle:200,bed:60},new AbortController().signal);if(paused)await t.port.pause(new AbortController().signal);
  assert.equal(t.port.status.busy,false);assert.equal(t.f.fw.motion.length,0);const stopping=t.generation.group.stop(cause);
  assert.equal(t.port.status.failed,true);assert.equal(t.kinematics.status.homedAxes,'');assert.equal(device.status.fault,cause);assert.equal(outputStops,1);
  await stopping;await device.stop();assert.equal(device.status.file?.closed,true);assert.equal(t.f.stops,1);assert.equal(outputStops,1);
 }finally{await device.stop();await t.close();await rm(dir,{recursive:true,force:true});}
});
test('parked print controller receives an independent firmware fault without resuming the file',async()=>{
 const {PrintController}=await import('../src/operations/print.ts'),t=await nativeLinearFixture(),dir=await mkdtemp(join(tmpdir(),'native-controller-fault-')),path=join(dir,'test.gcode'),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let outputStops=0;
 const dispatch=new GCodeDispatch({output(){},shutdown:reason=>{void t.port.motorOff(new Error(reason));}});dispatch.register('G1',async()=>{entered.resolve();await gate.promise;});
 const motion=bindNativeFileMotion(t.port,{parkXY:[50,0],retract:0,lift:0,travelSpeed:10,liftSpeed:5,retractSpeed:5},{prepare:async()=>dispatch.setReady(true),start:async()=>{},finishOutputs:async()=>assert.fail('faulted print finished normally'),stopOutputs:async()=>{outputStops++;}});
 const device=new FilePrintDevice(motion,dispatch,async()=>GCodeFileReader.adopt(await open(path,'r'))),controller=new PrintController(device,{maxNozzle:300,maxBed:130});
 try{
  t.kinematics.markHomed([0,1,2]);await writeFile(path,'G1 X51\nG1 X52\n');await controller.start({version:1,requestId:'job',fileId:'file',nozzle:200,bed:60});await entered.promise;
  const paused=controller.pause();gate.resolve();await paused;assert.equal(controller.state,'paused');assert.equal(t.port.status.busy,false);
  const cause=new Error('lost parked MCU');const stopped=t.generation.group.stop(cause);assert.equal(controller.state,'failed');assert.equal(controller.failure,cause);await stopped;await controller.fault(cause);assert.equal(outputStops,1);assert.equal(device.status.file?.position,0);assert.equal(device.status.file?.closed,true);
 }finally{gate.resolve();await device.stop();await t.close();await rm(dir,{recursive:true,force:true});}
});
