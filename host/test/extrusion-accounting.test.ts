import test from 'node:test';
import assert from 'node:assert/strict';
import {GCodeMove} from '../src/gcode/move.ts';
import {ExtrusionAccounting} from '../src/gcode/extrusion-accounting.ts';
import {PrintController} from '../src/operations/print.ts';
function fixture(){let position=[0,0,0,0],reject=false;const move=new GCodeMove({position:()=>position,move(p){if(reject)throw Error('rejected');position=[...p];}});return {move,reject(){reject=true;}};}
test('accepted signed extrusion survives coordinate origins, overrides and saved state without counting rejected motion',()=>{
 const {move,reject}=fixture(),meter=move.extrusionAccounting;move.execute('G1',{E:10});assert.equal(meter.filamentUsed,0);meter.begin();
 move.execute('G92',{E:0});move.execute('G1',{E:5});move.execute('M221',{S:200});move.execute('G1',{E:7});assert.equal(meter.filamentUsed,7);
 move.execute('M83');move.execute('G1',{E:-1});move.execute('G1',{E:1});move.execute('SAVE_GCODE_STATE');move.execute('G1',{E:3});move.execute('RESTORE_GCODE_STATE',{MOVE:1});assert.equal(meter.filamentUsed,10);
 move.resetPosition();move.activateExtruder();assert.equal(meter.filamentUsed,10);move.temporaryExtrusion(2,600);assert.equal(meter.filamentUsed,12);
 reject();assert.throws(()=>move.execute('G1',{E:3}));assert.throws(()=>move.temporaryExtrusion(2,600));assert.equal(meter.filamentUsed,12);
});
test('compensated totals retain small accepted deltas and overflow is unknown without rejecting motion',()=>{
 const meter=new ExtrusionAccounting();meter.begin();meter.accepted(0,1e16,1);meter.accepted(0,1,1);meter.accepted(0,1,1);assert.equal(meter.filamentUsed,10000000000000002);
 meter.begin();meter.accepted(-1e308,1e308,1);assert.equal(meter.filamentUsed,null);meter.accepted(0,1,1);assert.equal(meter.filamentUsed,null);meter.reset();assert.equal(meter.filamentUsed,0);
});
test('controller excludes confirmed pause adjustments, resumes once and freezes terminal statistics',async()=>{
 const {move}=fixture(),meter=move.extrusionAccounting;move.execute('M83');
 const controller=new PrintController({async prepare(){move.execute('G1',{E:2});},async start(){},async pause(){move.execute('G1',{E:-1});},async resume(){move.execute('G1',{E:1});},async finish(){},async stop(){}},{maxNozzle:300,maxBed:120},{},{extrusionAccounting:meter});
 try{
  await controller.start({version:1,requestId:'job',fileId:'file',nozzle:0,bed:0});assert.equal(controller.filamentUsed,2);move.execute('G1',{E:10});await controller.pause();assert.equal(controller.filamentUsed,11);
  await controller.adjustPaused(async()=>move.temporaryExtrusion(5,600));assert.equal(controller.filamentUsed,11);await controller.resume();move.execute('G1',{E:4});assert.equal(controller.filamentUsed,15);
  await controller.complete('job');move.execute('G1',{E:3});assert.equal(controller.filamentUsed,15);controller.reset('job');assert.equal(controller.filamentUsed,0);
 }finally{await controller.retire();}
});
test('fault cleanup cannot add consumption and missing restored history stays unknown',async()=>{
 const {move}=fixture(),meter=move.extrusionAccounting;move.execute('M83');
 const controller=new PrintController({async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){move.execute('G1',{E:9});}},{maxNozzle:300,maxBed:120},{},{extrusionAccounting:meter});
 try{await controller.start({version:1,requestId:'fault',fileId:'file',nozzle:0,bed:0});move.execute('G1',{E:2});await controller.fault(Error('fault'));await controller.cancel();assert.equal(controller.filamentUsed,2);meter.restoreUnknown();meter.setActive(true);move.execute('G1',{E:2});assert.equal(meter.filamentUsed,null);}finally{await controller.retire();}
});
test('print duration begins at first net-positive extrusion and is independent of query frequency',t=>{
 let now=0,reads=0;t.mock.method(performance,'now',()=>{reads++;return now;});
 const meter=new ExtrusionAccounting();meter.begin();now=1000;meter.accepted(0,-1,1);now=2000;meter.accepted(0,1,1);assert.equal(meter.printDuration,0);assert.equal(reads,0);
 now=3000;meter.accepted(0,1e-7,1);assert.equal(reads,1);now=4000;meter.accepted(0,2,1);meter.accepted(0,-3,1);assert.equal(reads,1); // No per-move timestamps, no restart after a retraction.
 now=5000;assert.equal(meter.printDuration,2);meter.setActive(false);now=9000;assert.equal(meter.printDuration,2);meter.setActive(false);meter.accepted(0,10,1);assert.equal(meter.printDuration,2);
 meter.setActive(true);meter.setActive(true);now=12000;assert.equal(meter.printDuration,5);meter.setActive(false);now=20000;assert.equal(meter.printDuration,5);
 meter.reset();assert.equal(meter.printDuration,0);meter.restoreUnknown();assert.equal(meter.printDuration,null);meter.begin();meter.accepted(-1e308,1e308,1);assert.equal(meter.printDuration,null);
});
test('paused cancellation and resume preparation never accrue effective print time',async t=>{
 let now=0;t.mock.method(performance,'now',()=>now);const {move}=fixture();move.execute('M83');
 const resume=Promise.withResolvers<void>(),stop=Promise.withResolvers<void>();
 const controller=new PrintController({async prepare(){},async start(){},async pause(){},resume:()=>resume.promise,async finish(){},stop:()=>stop.promise},{maxNozzle:300,maxBed:120},{},{extrusionAccounting:move.extrusionAccounting});
 try{
  await controller.start({version:1,requestId:'timed',fileId:'file',nozzle:0,bed:0});now=2000;assert.equal(controller.printDuration,0);move.execute('G1',{E:1});now=5000;await controller.pause();assert.equal(controller.printDuration,3);
  const resumed=controller.resume();now=10000;assert.equal(controller.printDuration,3);resume.resolve();await resumed;now=12000;await controller.pause();assert.equal(controller.printDuration,5);
  const cancelled=controller.cancel();now=20000;move.execute('G1',{E:10});assert.equal(controller.printDuration,5);assert.equal(controller.filamentUsed,1);stop.resolve();await cancelled;now=30000;assert.equal(controller.printDuration,5);assert.equal(controller.totalDuration,20);controller.reset('timed');assert.equal(controller.printDuration,0);
 }finally{resume.resolve();stop.resolve();await controller.retire();}
});
