import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HostRecoveryJournal,type RecoveryRecord,type MachineRecoveryKind} from '../src/runtime/host-recovery-journal.ts';
import {recoveryJournalV3} from './helpers/recovery-journal-v1.ts';
import {execFileSync} from 'node:child_process';
import {ProductHostControl,machineRecoveryKinds} from '../src/runtime/product-host-control.ts';
const record=(id:string,kind:MachineRecoveryKind,service?:string):RecoveryRecord=>({request_id:id,state_token:'original-token',state:'queued',error:null,kind,...service===undefined?{}:{service}});
async function finish(journal:HostRecoveryJournal,r:RecoveryRecord){await journal.save(r);await journal.save({...r,state:'running'});await journal.save({...r,state:'succeeded'});}
test('v3 migration preserves old kinds and identities, including pending firmware work; wrong identity does not write',async()=>{
 const root=await mkdtemp(join(tmpdir(),'machine-recovery-v3-')),options={path:join(root,'recovery.db'),deviceId:'printer'};
 const previous:RecoveryRecord[]=[{request_id:'machine-old-looking-id',state_token:'original-token',state:'succeeded',error:null},{request_id:'ordinary',state_token:'original-token',state:'succeeded',error:null,kind:'restart'},{request_id:'pending-firmware',state_token:'original-token',state:'queued',error:null,kind:'firmware_restart'}];recoveryJournalV3(options.path,options.deviceId,previous);
 try{
  const before=await readFile(options.path);await assert.rejects(HostRecoveryJournal.open({...options,deviceId:'other'}),/device mismatch/);assert.deepEqual(await readFile(options.path),before);
  const opened=await HostRecoveryJournal.open(options);try{assert.deepEqual(opened.records,[previous[0],previous[1],{...previous[2],state:'interrupted',error:'Process ended before acknowledged recovery completion'}]);await finish(opened.journal,record('service-admitted','service_restart','crowsnest'));}finally{await opened.journal.close();}
  const db=new DatabaseSync(options.path,{readOnly:true});try{assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,4);}finally{db.close();}
 }finally{await rm(root,{recursive:true,force:true});}
});
test('new machine kinds require exact immutable service identity and share the single durable pending slot',async()=>{
 const root=await mkdtemp(join(tmpdir(),'machine-recovery-identity-')),options={path:join(root,'recovery.db'),deviceId:'printer'},opened=await HostRecoveryJournal.open(options);
 try{
  for(const malformed of [record('bad','service_start'),record('bad','server_restart','crowsnest'),record('bad','service_stop','../ssh'),{...record('bad','machine_reboot'),kind:'unknown'},{...record('bad','service_restart','crowsnest'),force:true}])await assert.rejects(opened.journal.save(malformed as RecoveryRecord),/Invalid recovery/);
  const pending=record('requested','service_start','crowsnest');await opened.journal.save(pending);await assert.rejects(opened.journal.save(record('parallel','machine_shutdown')),/UNIQUE/);await assert.rejects(opened.journal.save({...pending,service:'ssh',state:'running'}),/identity/);
  await opened.journal.save({...pending,state:'running'});await opened.journal.save({...pending,state:'succeeded'});await assert.rejects(opened.journal.save({...pending,state:'failed'}),/transition/);
 }finally{await opened.journal.close();await rm(root,{recursive:true,force:true});}
});
test('machine outcome capacity cannot evict controlled or firmware receipts and a failed admission rolls back expiry',async()=>{
 const root=await mkdtemp(join(tmpdir(),'machine-recovery-capacity-')),options={path:join(root,'recovery.db'),deviceId:'printer'};let opened=await HostRecoveryJournal.open(options);
 try{
  const firmware:RecoveryRecord={request_id:'firmware-old',state_token:'original-token',state:'queued',error:null,kind:'firmware_restart'};await finish(opened.journal,firmware);
  for(let i=0;i<64;i++)await finish(opened.journal,record('service-'+i,'service_restart','crowsnest'));
  await opened.journal.save(record('other-pending','machine_shutdown'));await assert.rejects(opened.journal.save(record('rejected','service_restart','crowsnest')),/UNIQUE/);await opened.journal.close();opened=await HostRecoveryJournal.open(options);
  assert.equal(opened.records.find(r=>r.request_id==='service-0')?.state,'succeeded');assert.equal(opened.records.find(r=>r.request_id==='other-pending')?.state,'interrupted');assert.equal(opened.records.find(r=>r.request_id==='firmware-old')?.kind,'firmware_restart');assert.equal(opened.records.find(r=>r.request_id==='rejected'),undefined);
  const write=await opened.journal.save(record('replacement','service_restart','crowsnest'));assert.deepEqual(write.expired,['service-0']);await opened.journal.save({...write.record,state:'failed',error:'Not handed off'});
  await opened.journal.close();opened=await HostRecoveryJournal.open(options);assert.equal(opened.records.filter(r=>r.kind==='service_restart').length,64);assert.equal(opened.records.find(r=>r.request_id==='firmware-old')?.state,'succeeded');
 }finally{await opened.journal.close();await rm(root,{recursive:true,force:true});}
});
test('queued and running system tasks reopen as interrupted; journal restoration never executes a command',async()=>{
 for(const state of ['queued','running'] as const){const root=await mkdtemp(join(tmpdir(),'machine-recovery-interrupted-')),options={path:join(root,'recovery.db'),deviceId:'printer'};let opened=await HostRecoveryJournal.open(options);
  try{const r=record('power-request','machine_reboot');await opened.journal.save(r);if(state==='running')await opened.journal.save({...r,state});await opened.journal.close();opened=await HostRecoveryJournal.open(options);assert.deepEqual(opened.records,[{...r,state:'interrupted',error:'Process ended before acknowledged recovery completion'}]);}
  finally{await opened.journal.close();await rm(root,{recursive:true,force:true});}
 }
});
test('SIGKILL preserves machine payloads as interrupted outcomes without replaying service or power commands',async()=>{
 for(const kind of ['service_restart','machine_shutdown'] as const)for(const state of ['queued','running'] as const){
  const root=await mkdtemp(join(tmpdir(),'machine-recovery-crash-')),options={path:join(root,'recovery.db'),deviceId:'printer'},r=record('crashed',kind,kind==='service_restart'?'crowsnest':undefined),control=new ProductHostControl();
  try{
   const source=`import {HostRecoveryJournal} from ${JSON.stringify(new URL('../src/runtime/host-recovery-journal.ts',import.meta.url).href)};const {journal}=await HostRecoveryJournal.open(${JSON.stringify(options)});const record=${JSON.stringify(r)};await journal.save(record);${state==='running'?"await journal.save({...record,state:'running'});":''}process.kill(process.pid,'SIGKILL');`;
   assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',source],{stdio:'pipe',timeout:10000}),error=>(error as NodeJS.ErrnoException&{signal?:string}).signal==='SIGKILL');
   await control.configure(options);let commands=0;control.attach(async()=>{commands++;},()=>{},{kinds:machineRecoveryKinds});assert.deepEqual(control.operation('crashed'),{...r,state:'interrupted',error:'Process ended before acknowledged recovery completion'});assert.equal(control.status.machine_control.operations[0].service,r.service);await new Promise(resolve=>setImmediate(resolve));assert.equal(commands,0);
  }finally{await control.close();await rm(root,{recursive:true,force:true});}
 }
});
