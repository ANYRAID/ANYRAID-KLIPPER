import test from 'node:test';
import assert from 'node:assert/strict';
import {nativePrintFixture} from './helpers/native-linear-print.ts';
import {createNativeLinearPrint} from '../src/operations/native-linear-print.ts';
import {nativeLinearFixture,nativeStreamStarted} from './helpers/native-linear-port.ts';
import {ObjectCommands} from '../src/gcode/object-commands.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
for(const filtered of [false,true])test(`first exclusion while physically parked preserves retained motion and extrusion (filtered=${filtered})`,async()=>{
 const f=await nativeLinearFixture(0,()=>true,filtered),signal=new AbortController().signal,objects=new ObjectCommands(f.coordinates,f.port),dispatch=new GCodeDispatch({output(){},shutdown(){}});objects.register(dispatch);dispatch.setReady(true);
 try{
  f.kinematics.markHomed([0,1,2]);f.coordinates.execute('G1',{X:51,E:2.02,F:30});const running=f.port.drain(signal);await nativeStreamStarted(f);const pause=await f.port.pauseStream(signal),p=[...pause.position];
  await f.port.movePaused([51.5,.2,p[2]+.2,p[3]-.01],10,signal);await dispatch.execute('EXCLUDE_OBJECT_START NAME=A');objects.exclude('A');
  assert.deepEqual(f.port.position(),[51,0,0,2.02]);assert.notDeepEqual(f.generation.source.status.position,f.port.position());
  await f.port.movePaused(p,10,signal);await f.port.resumeStream(signal);await running;
  for(let i=1;i<=5;i++)f.coordinates.execute('G1',{E:2.02+i*.01,F:60});
  f.coordinates.execute('G1',{X:52,E:2.17,F:600});await dispatch.execute('EXCLUDE_OBJECT_START NAME=B');f.coordinates.execute('G1',{X:51.5,E:2.18,F:600});await f.port.drain(signal);
  assert(Math.abs(f.port.position()[3]-2.08)<1e-12);assert.equal(f.port.position()[0],51.5);const positions=new Map(f.generation.motion.bindings.map(b=>[b.id,b.history.status.lastPlannedPosition]));assert.equal(positions.get('x'),250n);assert.equal(positions.get('e'),28n);assert.equal(f.f.stops,0);
 }finally{await f.close();}
});
test('native file exclusion detaches before completion outputs and resets before next preparation',async()=>{
 const f=await nativePrintFixture('M83\nEXCLUDE_OBJECT_START NAME=a\nEXCLUDE_OBJECT CURRENT=1\nG1 E0.01 F60\nG1 E0.01\nG1 E0.01\nG1 E0.01\nG1 E0.01\nG1 X51 E0.1\nEXCLUDE_OBJECT_END\nEXCLUDE_OBJECT_START NAME=b\nG1 X52 E0.01 F600\n',false,false,false,1,undefined,true);
 const original=f.options.lifecycle.prepare;let preparations=0;
 f.options.lifecycle.prepare=async(...args)=>{assert.deepEqual(f.gcode.objects!.status,{objects:[],excluded_objects:[],current_object:null});assert(f.gcode.coordinates.usesPort(f.t.port));preparations++;await original(...args);};
 f.options.lifecycle.finishOutputs=async()=>{assert(f.gcode.coordinates.usesPort(f.t.port));assert.equal(f.gcode.objects!.status.current_object,null);assert.deepEqual(f.gcode.objects!.status.excluded_objects,['A']);};
 const owner=await createNativeLinearPrint(f.options),signal=new AbortController().signal;
 try{
  const eof=Promise.withResolvers<void>();owner.device.subscribeEOF(()=>eof.resolve());owner.device.subscribeFault(e=>eof.reject(e));
  await owner.device.prepare({version:1,requestId:'first',fileId:'file',nozzle:200,bed:60},signal);await owner.device.start('file',signal);await eof.promise;await owner.device.finish('first',signal);
  assert(Math.abs(f.t.port.position()[3]-2.06)<1e-12);assert.equal(f.t.port.position()[0],52);assert.equal(f.gcode.objects!.status.objects.length,2);
  await owner.device.prepare({version:1,requestId:'second',fileId:'file',nozzle:200,bed:60},signal);assert.equal(preparations,2);
 }finally{await owner.close();await f.close();}
});
