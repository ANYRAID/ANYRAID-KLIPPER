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
