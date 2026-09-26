import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PrintController,type PrintDevice} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {journalRequest} from '../src/operations/print-journal-types.ts';
const request={version:1 as const,requestId:'job',fileId:'file',nozzle:200,bed:60};
const limits={maxNozzle:300,maxBed:120};
function device(calls:string[]):PrintDevice{return {async prepare(){calls.push('prepare');},async start(){calls.push('start');},async pause(){},async resume(){},async finish(){},async stop(){calls.push('stop');}};}
test('Expired or malformed print requests have no device effects; legacy records stay canonical',async t=>{
 t.mock.method(Date,'now',()=>1000);const calls:string[]=[],controller=new PrintController(device(calls),limits);
 for(const expiresAt of [NaN,Infinity,-1,1.5,Number.MAX_SAFE_INTEGER+1]){await assert.rejects(controller.start({...request,expiresAt}),/Invalid print request/);assert.throws(()=>journalRequest({...request,expiresAt}),/Invalid print request/);}
 for(const expiresAt of [0,999,1000])await assert.rejects(controller.start({...request,expiresAt}),/expired/);
 assert.deepEqual(calls,[]);assert.deepEqual(journalRequest(request),request);assert.equal(controller.state,'idle');
});
test('An admitted preparation can finish after expiry; identical retries do not repeat effects or extend validity',async t=>{
 let now=1000;t.mock.method(Date,'now',()=>now);const prepared=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),calls:string[]=[],target=device(calls);
 target.prepare=async()=>{calls.push('prepare');prepared.resolve();await release.promise;};const controller=new PrintController(target,limits),input={...request,expiresAt:1500};
 const started=controller.start(input);await prepared.promise;now=2000;release.resolve();await started;
 await controller.start(input);assert.deepEqual(calls,['prepare','start']);await assert.rejects(controller.start({...input,expiresAt:3000}),/Idempotency key conflicts/);await controller.cancel();
});
test('A delayed durable reservation cannot admit after wall-clock rollback extends apparent validity',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'print-expiry-')),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'});let now=1000;t.mock.method(Date,'now',()=>now);const calls:string[]=[],reserve=journal.reserve.bind(journal);
 t.mock.method(journal,'reserve',async(...args:Parameters<PrintJournal['reserve']>)=>{now=500;await new Promise(r=>setTimeout(r,30));return reserve(...args);});
 try{const controller=new PrintController(device(calls),limits,{}, {journal});await assert.rejects(controller.start({...request,expiresAt:1010}),/expired/);assert.deepEqual(calls,['stop']);assert.equal((await journal.get('job'))?.state,'failed');assert.equal(controller.state,'failed');await controller.cancel();assert.equal((await journal.get('job'))?.state,'cancelled');}
 finally{await journal.close();await rm(dir,{recursive:true,force:true});}
});
test('Expiry is durable request identity and restart requires reconciliation without auto execution',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'print-expiry-recovery-')),options={path:join(dir,'jobs.db'),deviceId:'printer'},input={...request,expiresAt:Date.now()+60000};let journal=await PrintJournal.open(options);const calls:string[]=[];
 try{await journal.reserve(input);await assert.rejects(journal.reserve({...input,expiresAt:input.expiresAt+1}),/conflicts/);await journal.close();journal=await PrintJournal.open(options);assert.deepEqual((await journal.get('job'))?.request,input);assert.equal((await journal.active())?.state,'interrupted');
  const controller=await PrintController.restore(device(calls),limits,{}, {journal});assert.deepEqual(calls,[]);await assert.rejects(controller.start(input),/interrupted/);assert.deepEqual(calls,[]);await controller.cancel();
 }finally{await journal.close();await rm(dir,{recursive:true,force:true});}
});
