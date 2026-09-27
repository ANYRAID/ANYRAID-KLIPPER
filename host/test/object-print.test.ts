import test from 'node:test';
import assert from 'node:assert/strict';
import {nativePrintFixture} from './helpers/native-linear-print.ts';
import {createNativeLinearPrint} from '../src/operations/native-linear-print.ts';
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
