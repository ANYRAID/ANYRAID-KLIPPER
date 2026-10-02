import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {PrintController,type PrintDevice} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
const request={version:1 as const,requestId:'job',fileId:'file',nozzle:0,bed:0};
const device=(overrides:Partial<PrintDevice>={}):PrintDevice=>({async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){},...overrides});
test('retirement outlives cancellation timeout, late preparation and terminal journal write',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'print-retire-')),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'});
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),writing=Promise.withResolvers<void>(),written=Promise.withResolvers<void>();let stops=0;
 const maintenanceGate=new MaintenanceGate(),controller=await PrintController.restore(device({async prepare(){entered.resolve();await release.promise;},async stop(){stops++;}}),{maxNozzle:300,maxBed:130},{stopMs:10},{journal,maintenanceGate});
 const transition=journal.transition.bind(journal);t.mock.method(journal,'transition',async(...args:Parameters<typeof transition>)=>{writing.resolve();await written.promise;return transition(...args);});
 let retiring:Promise<void>|undefined;
 try{
  const started=controller.start(request),rejected=assert.rejects(started);await entered.promise;
  let settled=false;retiring=controller.retire().finally(()=>{settled=true;});assert.equal(controller.retire(),controller.cancel());assert.equal(maintenanceGate.status.closed,true);
  await rejected;await delay(25);assert.equal(settled,false);assert.equal(controller.pendingDeviceActions,1);assert.equal((await journal.get('job'))?.state,'reserved');
  release.resolve();await writing.promise;assert.equal(settled,false);assert.equal(stops,2);
  written.resolve();await retiring;assert.equal(controller.pendingDeviceActions,0);assert.equal((await journal.get('job'))?.state,'cancelled');
  await assert.rejects(controller.start({...request,requestId:'late'}),/retired/);await assert.rejects(controller.pause(),/retired/);await assert.rejects(controller.resume(),/retired/);await assert.rejects(controller.complete('job'),/retired/);assert.throws(()=>controller.reset('job'),/retired/);
 }finally{release.resolve();written.resolve();await retiring?.catch(()=>{});await journal.close();await rm(dir,{recursive:true,force:true});}
});
test('retirement stops idle hardware once and closes state and device subscriptions',async()=>{
 let stops=0,detached=0;const controller=new PrintController(device({async stop(){stops++;},subscribeFault(){return ()=>{detached++;};},subscribeEOF(){return ()=>{detached++;};}}),{maxNozzle:300,maxBed:130});
 const watch=controller.watchState(new AbortController().signal);await watch.next();const pending=watch.next(),first=controller.retire();assert.equal(controller.retire(),first);await first;
 assert.deepEqual(await pending,{done:true,value:undefined});assert.equal(controller.stateObservers,0);assert.equal(stops,1);assert.equal(detached,2);assert.throws(()=>controller.watchState(new AbortController().signal),/retired/);
 await controller.fault(new Error('late notification'));assert.equal(stops,1);
});
test('retirement retains actual safety failure after cleanup settles',async()=>{
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();const controller=new PrintController(device({async stop(){entered.resolve();await release.promise;throw new Error('physical stop failed');}}),{maxNozzle:300,maxBed:130});
 let settled=false;const retiring=controller.retire().finally(()=>{settled=true;}),rejected=assert.rejects(retiring,error=>error instanceof AggregateError&&error.errors.some(e=>e.message==='physical stop failed'));
 await entered.promise;assert.equal(settled,false);release.resolve();await rejected;assert.equal(controller.pendingDeviceActions,0);await assert.rejects(controller.start(request),/retired/);
});
test('only fully retired controllers release a live journal to the next device owner',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'journal-handoff-')),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'});let next:PrintController|undefined;
 const first=new PrintController(device(),{maxNozzle:300,maxBed:130},{},{journal});let oldEvents=0;first.subscribeHistory(()=>{oldEvents++;});
 try{
  assert.throws(()=>new PrintController(device(),{maxNozzle:300,maxBed:130},{},{journal}),/owned/);
  await first.retire();assert.equal(journal.closed,false);assert.throws(()=>first.historyDelete('1'),/retired/);assert.throws(()=>first.historyResetTotals(),/retired/);assert.throws(()=>first.subscribeHistory(()=>{}),/retired/);
  next=await PrintController.restore(device(),{maxNozzle:300,maxBed:130},{},{journal});await next.start(request);await next.cancel();assert.equal(oldEvents,0);assert.equal((await journal.historyList()).length,1);await next.retire();
  const failed=new PrintController(device({async stop(){throw Error('physical stop failed');}}),{maxNozzle:300,maxBed:130},{},{journal});await assert.rejects(failed.retire(),/retirement failed/);assert.throws(()=>new PrintController(device(),{maxNozzle:300,maxBed:130},{},{journal}),/owned/);
 }finally{await next?.retire().catch(()=>{});await first.retire();await journal.close();await rm(dir,{recursive:true,force:true});}
});
