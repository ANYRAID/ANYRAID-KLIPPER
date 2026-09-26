import test from 'node:test';
import assert from 'node:assert/strict';
import {PrintLayerInfo} from '../src/gcode/print-layer-info.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {PrintController} from '../src/operations/print.ts';
import {productPrintStatus} from '../src/runtime/product-print-status.ts';
test('slicer layers follow defaults, reset and clamp semantics and reject invalid changes atomically',()=>{
 const layers=new PrintLayerInfo();layers.update({CURRENT_LAYER:'8'});assert.deepEqual({...layers.status},{total_layer:null,current_layer:null});layers.update({TOTAL_LAYER:'100',CURRENT_LAYER:'3'});assert.deepEqual({...layers.status},{total_layer:100,current_layer:3});layers.update({TOTAL_LAYER:'2'});assert.deepEqual({...layers.status},{total_layer:2,current_layer:2});layers.update({CURRENT_LAYER:'1'});assert.equal(layers.status.current_layer,1);
 for(const value of ['-1','1.1','nan','9007199254740992','1__0']){assert.throws(()=>layers.update({TOTAL_LAYER:'5',CURRENT_LAYER:value}));assert.deepEqual({...layers.status},{total_layer:2,current_layer:1});}
 layers.update({TOTAL_LAYER:'+1_0',CURRENT_LAYER:'９'});assert.deepEqual({...layers.status},{total_layer:10,current_layer:9});layers.update({TOTAL_LAYER:'-0'});assert.deepEqual({...layers.status},{total_layer:null,current_layer:null});layers.reset('next');assert.equal(layers.requestId,'next');const snapshot=layers.status;snapshot.current_layer=99;assert.equal(layers.status.current_layer,null);
});
test('layer metadata uses normal command admission and has no motion or lifecycle effects',async()=>{
 let stops=0;const dispatch=new GCodeDispatch({output(){},shutdown(){stops++;},unknownCommand:'shutdown'}),layers=new PrintLayerInfo();layers.register(dispatch);
 await assert.rejects(dispatch.execute('SET_PRINT_STATS_INFO TOTAL_LAYER=10'),/not ready/);dispatch.setReady(true);await dispatch.execute('SET_PRINT_STATS_INFO TOTAL_LAYER=10\nSET_PRINT_STATS_INFO CURRENT_LAYER=12');assert.deepEqual({...layers.status},{total_layer:10,current_layer:10});assert.equal(stops,0);assert.throws(()=>layers.register(dispatch),/duplicate/);
});
test('print status does not report completion or cancellation before acknowledged controller transitions',async()=>{
 const finish=Promise.withResolvers<void>(),stop=Promise.withResolvers<void>(),request={version:1 as const,requestId:'one',fileId:'file',nozzle:0,bed:0};let eof:(id:string)=>void=()=>{};
 const controller=new PrintController({subscribeEOF(listener){eof=listener;return ()=>{};},prepare:async()=>{},start:async()=>{},pause:async()=>{},resume:async()=>{},finish:async()=>finish.promise,stop:async()=>stop.promise},{maxNozzle:300,maxBed:120}),layers=new PrintLayerInfo(),status=()=>productPrintStatus(controller,layers);
 try{
  assert.equal(status().state,'standby');assert.deepEqual(productPrintStatus({state:'interrupted',currentRequest:undefined},layers),{state:'error',message:'Print interrupted; recovery required',info:{total_layer:null,current_layer:null}});assert.equal(productPrintStatus({state:'failed',currentRequest:undefined},layers).message,'Native print failed');layers.reset('old');layers.update({TOTAL_LAYER:'10'});await controller.start(request);assert.deepEqual(status().info,{total_layer:null,current_layer:null});layers.reset('one');layers.update({TOTAL_LAYER:'20',CURRENT_LAYER:'2'});assert.equal(status().info.current_layer,2);await controller.pause();assert.equal(status().state,'paused');const resumed=controller.resume();assert.equal(status().state,'paused');await resumed;assert.equal(status().state,'printing');
  eof('one');assert.equal(controller.state,'finishing');assert.equal(status().state,'printing');finish.resolve();await controller.complete('one');assert.equal(status().state,'complete');controller.reset('one');assert.equal(status().state,'standby');assert.equal(status().info.current_layer,null);
  await controller.start({...request,requestId:'two'});const cancelled=controller.cancel();assert.notEqual(status().state,'cancelled');stop.resolve();await cancelled;assert.equal(status().state,'cancelled');assert.equal(status().info.current_layer,null);
 }finally{finish.resolve();stop.resolve();await controller.retire();}
});

test('published filename and pause flag follow accepted request and acknowledged controller boundaries',async()=>{
 const {productPauseStatus}=await import('../src/runtime/product-print-status.ts'),layers=new PrintLayerInfo(),pause=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>();
 const controller=new PrintController({async prepare(){},async start(){},pause:()=>pause.promise,resume:()=>resume.promise,async finish(){},async stop(){}},{maxNozzle:300,maxBed:120});
 const status=()=>productPrintStatus(controller,layers,id=>id+'.gcode'),paused=()=>productPauseStatus(controller.state).is_paused;
 try{
  assert.equal(status().filename,'');assert.equal(paused(),false);await controller.start({version:1,requestId:'first',fileId:'receipt-a',nozzle:0,bed:0});assert.equal(status().filename,'receipt-a.gcode');
  const pausing=controller.pause();assert.equal(controller.state,'pausing');assert.equal(paused(),false);pause.resolve();await pausing;assert.equal(paused(),true);
  const resuming=controller.resume();assert.equal(controller.state,'resuming');assert.equal(paused(),true);resume.resolve();await resuming;assert.equal(paused(),false);
  await controller.complete('first');assert.equal(status().filename,'receipt-a.gcode');controller.reset('first');assert.equal(status().filename,'');
  await controller.start({version:1,requestId:'second',fileId:'receipt-b',nozzle:0,bed:0});assert.equal(status().filename,'receipt-b.gcode');await controller.fault(Error('private cause'));assert.equal(status().filename,'receipt-b.gcode');assert.equal(paused(),false);assert(!status().message.includes('private'));
 }finally{pause.resolve();resume.resolve();await controller.cancel();}
});
