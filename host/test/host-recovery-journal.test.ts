import {execFileSync} from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,symlink,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {HostRecoveryJournal,type RecoveryRecord} from '../src/runtime/host-recovery-journal.ts';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
const record=(id:string):RecoveryRecord=>({request_id:id,state_token:'old-token',state:'queued',error:null});
test('recovery journal preserves completed receipts, interrupts pending work and locks ownership',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'recovery-journal-')),options={path:join(dir,'recovery.db'),deviceId:'printer'};let opened=await HostRecoveryJournal.open(options);
 try{await opened.journal.save(record('done'));await opened.journal.save({...record('done'),state:'running'});await opened.journal.save({...record('done'),state:'succeeded'});await opened.journal.save(record('pending'));await assert.rejects(opened.journal.save(record('other')));await assert.rejects(HostRecoveryJournal.open(options),/locked/);await opened.journal.close();opened=await HostRecoveryJournal.open(options);assert.equal(opened.records.find(r=>r.request_id==='done')?.state,'succeeded');assert.equal(opened.records.find(r=>r.request_id==='pending')?.state,'interrupted');await assert.rejects(opened.journal.save({...record('done'),state:'failed'}),/transition/);await assert.rejects(opened.journal.save({...record('done'),state_token:'wrong'}),/identity/);await opened.journal.close();const before=await readFile(options.path);await assert.rejects(HostRecoveryJournal.open({...options,deviceId:'other'}),/device mismatch/);assert.deepEqual(await readFile(options.path),before);const link=join(dir,'linked');await symlink(options.path,link);await assert.rejects(HostRecoveryJournal.open({...options,path:link}));}
 finally{await opened.journal.close();await rm(dir,{recursive:true,force:true});}
});
test('control persists admission and interrupted requests never replay in a new process owner',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'recovery-control-')),options={path:join(dir,'recovery.db'),deviceId:'printer'},first=new ProductHostControl(),second=new ProductHostControl();let calls=0,send:((sent:boolean)=>void)|undefined;
 try{await first.configure(options);first.attach(async()=>{calls++;});const token=first.status.state_token;assert.equal((await first.request('done',token,callback=>{send=callback;})).state,'queued');send!(true);const end=performance.now()+3000;while(first.operation('done')?.state!=='succeeded'){assert(performance.now()<end);await new Promise(resolve=>setTimeout(resolve,5));}await first.close();
 const pending=await HostRecoveryJournal.open(options);await pending.journal.save(record('interrupted'));await pending.journal.close();await second.configure(options);second.attach(async()=>{calls++;});assert.equal(second.status.durable,true);assert.equal(second.operation('done')?.state,'succeeded');assert.equal((await second.request('done',token,()=>assert.fail())).state,'succeeded');assert.equal((await second.request('interrupted','old-token',()=>assert.fail())).state,'interrupted');assert.equal(calls,1);await assert.rejects(second.request('new','old-token',()=>{}),/Stale/);}
 finally{await first.close();await second.close();await rm(dir,{recursive:true,force:true});}
});
test('SIGKILL releases SQLite ownership and converts queued or running receipts to interrupted without replay',async()=>{
 for(const state of ['queued','running'] as const){const dir=await mkdtemp(join(tmpdir(),'recovery-crash-')),options={path:join(dir,'recovery.db'),deviceId:'printer'};let control:ProductHostControl|undefined;try{
  const source=`import {HostRecoveryJournal} from ${JSON.stringify(new URL('../src/runtime/host-recovery-journal.ts',import.meta.url).href)};const {journal}=await HostRecoveryJournal.open(${JSON.stringify(options)});const record=${JSON.stringify(record('crashed'))};await journal.save(record);${state==='running'?"await journal.save({...record,state:'running'});":''}process.kill(process.pid,'SIGKILL');`;
  assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',source],{stdio:'pipe',timeout:10000}),error=>(error as NodeJS.ErrnoException&{signal?:string}).signal==='SIGKILL');
  control=new ProductHostControl();await control.configure(options);let calls=0;control.attach(async()=>{calls++;});assert.equal(control.operation('crashed')?.state,'interrupted');assert.equal((await control.request('crashed','old-token',()=>assert.fail())).state,'interrupted');assert.equal(calls,0);
 }finally{await control?.close();await rm(dir,{recursive:true,force:true});}}
});
test('storage failure at admission, dispatch or success never acknowledges an uncommitted outcome',async()=>{
 for(const stage of ['queued','running','succeeded'] as const){const dir=await mkdtemp(join(tmpdir(),'recovery-write-fault-')),options={path:join(dir,'recovery.db'),deviceId:'printer'},control=new ProductHostControl(),save=HostRecoveryJournal.prototype.save;let calls=0,send:((sent:boolean)=>void)|undefined;
  try{await control.configure(options);control.attach(async()=>{calls++;});HostRecoveryJournal.prototype.save=function(record){if(record.state===stage)return Promise.reject(new Error('injected write failure'));return save.call(this,record);};
   const admitted=control.request('fault',control.status.state_token,callback=>{send=callback;});if(stage==='queued'){await assert.rejects(admitted,/write failure/);assert.equal(send,undefined);assert.equal(control.operation('fault'),null);}else{await admitted;send!(true);const end=performance.now()+3000;while(!control.status.storage_failed){assert(performance.now()<end);await new Promise(resolve=>setTimeout(resolve,5));}assert.equal(control.operation('fault')?.state,stage==='running'?'queued':'running');}assert.equal(calls,stage==='succeeded'?1:0);assert.equal(control.status.available,false);await assert.rejects(control.close(),/write failure/);
  }finally{HostRecoveryJournal.prototype.save=save;await control.close().catch(()=>{});await rm(dir,{recursive:true,force:true});}
 }
});
test('shutdown waits for delayed admission write and persists cancellation without device effects',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'recovery-admission-close-')),options={path:join(dir,'recovery.db'),deviceId:'printer'},control=new ProductHostControl(),save=HostRecoveryJournal.prototype.save,entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let calls=0;
 try{await control.configure(options);control.attach(async()=>{calls++;});HostRecoveryJournal.prototype.save=async function(record){if(record.state==='queued'){entered.resolve();await release.promise;}return save.call(this,record);};const requested=control.request('closing',control.status.state_token,()=>assert.fail());void requested.catch(()=>{});await entered.promise;let closed=false;const closing=control.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);release.resolve();await assert.rejects(requested,/stopped/);await closing;assert.equal(calls,0);HostRecoveryJournal.prototype.save=save;const restored=await HostRecoveryJournal.open(options);try{assert.equal(restored.records[0].state,'failed');}finally{await restored.journal.close();}}
 finally{release.resolve();HostRecoveryJournal.prototype.save=save;await control.close();await rm(dir,{recursive:true,force:true});}
});
