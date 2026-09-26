import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PrintController,type PrintDevice} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
const request={version:1 as const,requestId:'job',fileId:'file',nozzle:200,bed:60};
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'fault-journal-')),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'});const device:PrintDevice={async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){}};const controller=new PrintController(device,{maxNozzle:300,maxBed:130},{},{journal});return {journal,device,controller,async close(){await controller.retire().catch(()=>{});await journal.close();await rm(dir,{recursive:true,force:true});}};}
test('device fault persists only after stop, coalesces callers and cannot restart',async()=>{
 const f=await fixture(),stop=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();try{await f.controller.start(request);f.device.stop=()=>{entered.resolve();return stop.promise;};const fault=f.controller.fault(new Error('ADC failure'));assert.equal(f.controller.fault(new Error('duplicate')),fault);await entered.promise;assert.equal(f.controller.state,'failed');assert.equal((await f.journal.get('job'))?.state,'started');stop.resolve();await fault;assert.equal((await f.journal.get('job'))?.state,'failed');assert.equal((await f.journal.get('job'))?.revision,3);await assert.rejects(f.controller.start({...request,requestId:'other'}));await f.controller.cancel();assert.equal((await f.journal.get('job'))?.state,'cancelled');}finally{stop.resolve();await f.close();}
});
test('preparation and pause failures persist failed after safe stop',async()=>{
 for(const phase of ['prepare','pause'] as const){const f=await fixture();try{f.device[phase]=async()=>{throw new Error('operation failure');};if(phase==='pause'){await f.controller.start(request);await assert.rejects(f.controller.pause(),/operation failure/);}else await assert.rejects(f.controller.start(request),/operation failure/);assert.equal((await f.journal.get('job'))?.state,'failed');}finally{await f.close();}}
});
test('late fault does not replace completed or cancelled durable outcomes',async()=>{
 for(const terminal of ['completed','cancelled']){const f=await fixture();try{await f.controller.start(request);if(terminal==='completed')await f.controller.complete('job');else await f.controller.cancel();await f.controller.fault(new Error('late hardware failure'));assert.equal((await f.journal.get('job'))?.state,terminal);}finally{await f.close();}}
});
test('failed physical stop never publishes acknowledged failed outcome',async()=>{
 const f=await fixture();try{await f.controller.start(request);f.device.stop=async()=>{throw new Error('physical stop failed');};await assert.rejects(f.controller.fault(new Error('ADC failure')),/physical stop failed/);assert.equal((await f.journal.get('job'))?.state,'started');}finally{await f.close();}
});
test('fault waits for delayed preparation and its late reservation before failed persistence',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();try{f.device.prepare=()=>{entered.resolve();return release.promise;};const started=f.controller.start(request);void started.catch(()=>{});await entered.promise;const fault=f.controller.fault(new Error('during preparation'));await Promise.resolve();assert.equal((await f.journal.get('job'))?.state,'reserved');release.resolve();await assert.rejects(started);await fault;assert.equal((await f.journal.get('job'))?.state,'failed');assert.equal((await f.journal.get('job'))?.revision,2);}finally{release.resolve();await f.close();}
});
test('fault rejects when failed outcome cannot be written',async()=>{
 const f=await fixture(),transition=f.journal.transition.bind(f.journal);try{await f.controller.start(request);f.journal.transition=async(...args)=>{if(args[2]==='failed')throw new Error('storage write failed');return transition(...args);};await assert.rejects(f.controller.fault(new Error('ADC failure')),/storage write failed/);assert.equal((await f.journal.get('job'))?.state,'started');}finally{f.journal.transition=transition;await f.close();}
});
