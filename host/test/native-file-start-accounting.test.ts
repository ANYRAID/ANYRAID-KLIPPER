import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,open,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {GCodeMove} from '../src/gcode/move.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
import {FilePrintDevice} from '../src/operations/file-print-device.ts';
import {bindNativeFileMotion} from '../src/operations/native-file-motion.ts';
import type {NativeLinearHomingPort} from '../src/homing/native-linear-port.ts';
const parking={parkXY:[1,2] as const,retract:0,lift:1,travelSpeed:10,liftSpeed:5,retractSpeed:5};
const request={version:1 as const,requestId:'job',fileId:'file',nozzle:0,bed:0};
test('first file stream after a prepared hold counts its prefix before the outer start acknowledgement',async t=>{
 let now=0;t.mock.method(performance,'now',()=>now);
 let position=[0,0,0,0];const move=new GCodeMove({position:()=>position,move(p){position=[...p];}});move.execute('M83');
 const meter=move.extrusionAccounting;meter.begin();meter.setActive(false); // Confirmed preparation hold, before any file command.
 const directory=await mkdtemp(join(tmpdir(),'file-start-accounting-')),path=join(directory,'part.gcode');
 // Binary-exact deltas isolate the lifecycle boundary from coordinate subtraction.
 await writeFile(path,'G92 E0\nG1 E0.125\nG1 E0.875\n');
 const startup=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),suffix=Promise.withResolvers<void>(),eof=Promise.withResolvers<void>(),outerAck=Promise.withResolvers<void>();
 let commands=0,starts=0;
 const dispatch=new GCodeDispatch({output(){},shutdown(){}});dispatch.setReady(true);
 dispatch.register('G92',command=>move.execute('G92',{E:Number(command.params.E)}));
 dispatch.register('G1',async command=>{move.execute('G1',{E:Number(command.params.E)});if(++commands===1){entered.resolve();await suffix.promise;}});
 const port={assertActive(){},subscribeStop(){return ()=>{};},async motorOff(){}} as unknown as NativeLinearHomingPort;
 const motion=bindNativeFileMotion(port,parking,{prepare:async()=>{},start:async()=>{starts++;move.execute('G1',{E:9});await startup.promise;},finishOutputs:async()=>{},stopOutputs:async()=>{}},()=>meter.setActive(true));
 const file=new FilePrintDevice(motion,dispatch,async()=>GCodeFileReader.adopt(await open(path,'r')));file.subscribeEOF(()=>eof.resolve());
 const start=async()=>{await file.start('file',new AbortController().signal);await outerAck.promise;};
 try{
  await file.prepare(request,new AbortController().signal);const starting=start();
  assert.equal(meter.filamentUsed,0);assert.equal(commands,0);now=10000;assert.equal(meter.printDuration,0);
  startup.resolve();await entered.promise;assert.equal(meter.filamentUsed,0.125);now=11000;assert.equal(meter.printDuration,1);
  suffix.resolve();await eof.promise;assert.equal(meter.filamentUsed,1);assert.equal(commands,2);assert.equal(starts,1);assert.equal(file.status.file?.phase,'eof');
  outerAck.resolve();await starting;meter.setActive(false);now=20000;assert.equal(meter.printDuration,1);assert.equal(meter.filamentUsed,1);
 }finally{startup.resolve();suffix.resolve();outerAck.resolve();await file.stop();await rm(directory,{recursive:true,force:true});}
});
for(const outcome of ['failed','stopped','aborted'] as const)test(`startup ${outcome} cannot enable file accounting or publish a late stream boundary`,async()=>{
 const gate=Promise.withResolvers<void>();let boundaries=0;
 const port={assertActive(){},async motorOff(){}} as unknown as NativeLinearHomingPort;
 const motion=bindNativeFileMotion(port,parking,{prepare:async()=>{},start:async()=>{await gate.promise;if(outcome==='failed')throw new Error('startup rejected');},finishOutputs:async()=>{},stopOutputs:async()=>{}},()=>{boundaries++;});
 const abort=new AbortController(),pending=motion.start(abort.signal),rejected=assert.rejects(pending,/startup rejected|stopped|aborted/);
 if(outcome==='stopped')await motion.stop();else if(outcome==='aborted')abort.abort(new Error('aborted'));
 gate.resolve();await rejected;assert.equal(boundaries,0);await motion.stop();
});
