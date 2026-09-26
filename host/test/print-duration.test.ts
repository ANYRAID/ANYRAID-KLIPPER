import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ExtrusionAccounting} from '../src/gcode/extrusion-accounting.ts';
import {PrintController} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {productPrintStatus} from '../src/runtime/product-print-status.ts';
import {PrintLayerInfo} from '../src/gcode/print-layer-info.ts';
const request={version:1 as const,requestId:'job',fileId:'file',nozzle:0,bed:0};
const device={async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){}};
const limits={maxNozzle:300,maxBed:120};
test('elapsed duration includes preparation, acknowledged pause and final drain, freezes and resets',async t=>{
 let now=1000;t.mock.method(performance,'now',()=>now);
 const preparation=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();
 const controller=new PrintController({...device,prepare:()=>preparation.promise,finish:()=>finish.promise},limits);
 const status=()=>productPrintStatus(controller,new PrintLayerInfo());
 try{
  assert.equal(status().total_duration,0);const started=controller.start(request);now=3000;assert.equal(status().total_duration,2);
  preparation.resolve();await started;await controller.pause();now=8000;assert.equal(status().total_duration,7);
  await controller.resume();const completed=controller.complete('job');now=11000;assert.equal(status().total_duration,10);
  finish.resolve();await completed;now=20000;assert.equal(status().total_duration,10);
  await controller.start(request);assert.equal(status().total_duration,10); // Idempotent replay cannot restart the clock.
  controller.reset('job');assert.equal(status().total_duration,0);
  await controller.start({...request,requestId:'next'});now=23000;await controller.cancel();now=30000;assert.equal(status().total_duration,3);
 }finally{preparation.resolve();finish.resolve();await controller.retire();}
});
test('fault freezes duration before cleanup and rejected admission never starts a timer',async t=>{
 let now=1000;t.mock.method(performance,'now',()=>now);const stop=Promise.withResolvers<void>();
 const controller=new PrintController({...device,stop:()=>stop.promise},limits);
 try{
  await assert.rejects(controller.start({...request,nozzle:999}));now=5000;assert.equal(controller.totalDuration,0);
  await controller.start(request);now=7000;const fault=controller.fault(Error('device fault'));now=10000;assert.equal(controller.totalDuration,2);
  stop.resolve();await fault;await controller.cancel();assert.equal(controller.totalDuration,2);
 }finally{stop.resolve();await controller.retire();}
});
test('restored interrupted jobs retain unknown duration until explicit terminal reset',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'duration-'));const path=join(directory,'journal.db');
 let journal=await PrintJournal.open({path,deviceId:'printer'});
 try{
  await journal.reserve(request);await journal.close();journal=await PrintJournal.open({path,deviceId:'printer'});
  const meter=new ExtrusionAccounting();meter.begin();meter.accepted(0,123,1);
  const controller=await PrintController.restore(device,limits,{}, {journal,extrusionAccounting:meter});
  try{assert.equal(controller.state,'interrupted');assert.equal(controller.filamentUsed,null);assert.equal(controller.totalDuration,null);await controller.cancel();assert.equal(controller.totalDuration,null);controller.reset('job');assert.equal(controller.totalDuration,0);assert.equal(controller.filamentUsed,0);}finally{await controller.retire();}
 }finally{await journal.close();await rm(directory,{recursive:true,force:true});}
});
