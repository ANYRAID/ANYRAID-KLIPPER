import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PrintJournal} from '../src/operations/print-journal.ts';
import type {JournalHistoryEvent} from '../src/operations/print-journal-types.ts';
const request={version:1 as const,requestId:'job',fileId:'file',nozzle:0,bed:0};
test('history observers receive committed immutable snapshots once, without changing durable acknowledgements',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'history-events-')),options={path:join(dir,'jobs.db'),deviceId:'printer'};let journal=await PrintJournal.open(options);const events:JournalHistoryEvent[]=[];
 try{
  journal.subscribeHistory(event=>{event.record.request={...request,fileId:'corrupt'};throw Error('observer failed');});
  journal.subscribeHistory(async()=>{throw Error('async observer failed');});
  journal.subscribeHistory(event=>{events.push(event);});
  await journal.reserve(request);await journal.reserve(request);assert.equal(events.length,1);assert.equal(events[0].record.historyId,'000001');assert.equal(events[0].record.request.fileId,'file');assert.equal(events[0].record.state,'reserved');
  await assert.rejects(journal.transition('job',2,'started'));assert.equal(events.length,1);
  await journal.transition('job',1,'started');assert.equal(events.length,1);
  await journal.transition('job',2,'failed',{totalDuration:2,printDuration:1,filamentUsed:3});assert.deepEqual(events.map(e=>e.action),['added','finished']);assert.equal(events[1].record.state,'failed');assert.equal(events[1].record.statistics!.filamentUsed,3);assert.equal(events[0].record.state,'reserved');assert.equal((await journal.get('job'))!.state,'failed');
  await journal.historyResetTotals();await journal.transition('job',3,'cancelled');await journal.historyDelete('1');assert.equal(events.length,2);assert.equal(journal.historyObserverErrors,4);
  await journal.close();journal=await PrintJournal.open(options);journal.subscribeHistory(e=>events.push(e));await journal.reserve(request);assert.equal(events.length,2);
 }finally{await journal.close();await rm(dir,{recursive:true,force:true});}
});

import {registerNativeHistory} from '../src/moonraker/native-history.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import type {PrintController} from '../src/operations/print.ts';
import type {NativePrintUploads} from '../src/moonraker/native-print-uploads.ts';
import {setTimeout as delay} from 'node:timers/promises';
test('notification queue bounds slow delivery, reports failure and cancels pending work on release',async()=>{
 let observer:((e:JournalHistoryEvent)=>void)|undefined,removed=false,calls=0;
 const controller={subscribeHistory(fn:(e:JournalHistoryEvent)=>void){observer=fn;return ()=>{removed=true;observer=undefined;};}} as unknown as PrintController;
 const files={async info(){return {};},filename(){return 'file.gcode';}} as unknown as NativePrintUploads;
 const blocked=Promise.withResolvers<void>(),registration=registerNativeHistory(new EndpointRegistry(new JsonRpcDispatcher()),controller,files,async()=>{calls++;await blocked.promise;throw Error('delivery failed');});
 const event:JournalHistoryEvent={action:'finished',record:{request,state:'completed',revision:3,historyId:'000001',statistics:{totalDuration:2,printDuration:1,filamentUsed:1}}};
 for(let i=0;i<70;i++)observer!(event);
 assert.equal(registration.status().pending,64);assert.equal(registration.status().dropped,6);assert.match(registration.status().error!,/queue full/);
 await delay(0);assert.equal(calls,1);registration();assert(removed);blocked.resolve();const until=performance.now()+1000;while(registration.status().pending){assert(performance.now()<until);await delay(1);}assert.equal(calls,1);assert(registration.status().closed);
 const failing=registerNativeHistory(new EndpointRegistry(new JsonRpcDispatcher()),controller,files,()=>{throw Error('delivery failed');});observer!(event);const end=performance.now()+1000;while(failing.status().pending){assert(performance.now()<end);await delay(1);}assert.equal(failing.status().error,'delivery failed');failing();
});
