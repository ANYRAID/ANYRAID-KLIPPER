import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {HostRecoveryJournal,type RecoveryRecord} from '../src/runtime/host-recovery-journal.ts';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
import {recoveryJournalV1,recoveryJournalV2} from './helpers/recovery-journal-v1.ts';
const record=(id:string,standard=false):RecoveryRecord=>({request_id:id,state_token:'original-token',state:'queued',error:null,...standard?{kind:'restart'}:{}});
async function finish(journal:HostRecoveryJournal,r:RecoveryRecord){await journal.save(r);await journal.save({...r,state:'running'});await journal.save({...r,state:'succeeded'});}
async function settled(control:ProductHostControl){const end=performance.now()+5000;while(control.status.busy){assert(performance.now()<end,'Receipt settlement timeout');await delay(1);}}
test('v2 full histories migrate atomically and firmware capacity cannot evict either older kind',async()=>{
 const root=await mkdtemp(join(tmpdir(),'firmware-journal-')),options={path:join(root,'recovery.db'),deviceId:'printer'},old=[...Array.from({length:128},(_,i)=>({...record('controlled-'+i),state:'succeeded' as const})),...Array.from({length:64},(_,i)=>({...record('restart-old-'+i,true),state:'succeeded' as const}))];recoveryJournalV2(options.path,options.deviceId,old);let control=new ProductHostControl();
 try{
  const before=await readFile(options.path);await assert.rejects(HostRecoveryJournal.open({...options,deviceId:'wrong'}),/device mismatch/);assert.deepEqual(await readFile(options.path),before);
  await control.configure(options);control.attach(async()=>{},()=>{},{kinds:['restart','firmware_restart']});const ids:string[]=[];
  for(let i=0;i<70;i++){ids.push((await control.requestFirmwareRestart(undefined,undefined,cb=>cb(true))).request_id);await settled(control);}
  assert.equal(control.status.recovery_history.standard_firmware_restart.retained,64);assert.equal(control.status.recovery_history.standard_restart.retained,64);assert.equal(control.status.recovery_history.controlled.retained,128);for(const r of old)assert.deepEqual(control.operation(r.request_id),r);assert.equal(control.operation(ids[0]),null);await assert.rejects(control.request(ids[0],control.status.state_token,()=>assert.fail()),/reserved/);await control.close();
  control=new ProductHostControl();await control.configure(options);assert.equal(control.status.firmware_restart_operation?.request_id,ids.at(-1));assert.equal(control.status.firmware_restart_operation?.state,'succeeded');assert.equal(control.status.restart_operation?.request_id,'restart-old-63');assert.equal(control.status.busy,false);
 }finally{await control.close();await rm(root,{recursive:true,force:true});}
});
test('v1 migration preserves all old identities, including generated-looking IDs and pending receipts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'recovery-v1-')),options={path:join(root,'recovery.db'),deviceId:'printer'};
 const old=[{...record('restart-not-a-standard-record'),state:'succeeded' as const},record('pending')];recoveryJournalV1(options.path,options.deviceId,old);let opened:Awaited<ReturnType<typeof HostRecoveryJournal.open>>|undefined;
 try{
  const before=await readFile(options.path);await assert.rejects(HostRecoveryJournal.open({...options,deviceId:'other'}),/device mismatch/);assert.deepEqual(await readFile(options.path),before);
  opened=await HostRecoveryJournal.open(options);assert.deepEqual(opened.records,[old[0],{...old[1],state:'interrupted',error:'Process ended before acknowledged recovery completion'}]);
  for(let i=0;i<150;i++)await finish(opened.journal,record('standard-'+i,true));await opened.journal.close();opened=await HostRecoveryJournal.open(options);
  assert.equal(opened.records.filter(r=>r.kind==='restart').length,64);assert.deepEqual(opened.records.find(r=>r.request_id===old[0].request_id),old[0]);assert.equal(opened.records.find(r=>r.request_id==='pending')?.state,'interrupted');assert.equal(opened.records.find(r=>r.request_id==='standard-85'),undefined);assert.equal(opened.records.find(r=>r.request_id==='standard-86')?.state,'succeeded');
  await opened.journal.close();const db=new DatabaseSync(options.path,{readOnly:true});try{assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,3);}finally{db.close();}
 }finally{await opened?.journal.close();await rm(root,{recursive:true,force:true});}
});
test('unknown or malformed legacy schemas are rejected without migrating their contents',async()=>{
 for(const version of [1,7]){
  const root=await mkdtemp(join(tmpdir(),'recovery-unknown-')),options={path:join(root,'recovery.db'),deviceId:'printer'};recoveryJournalV1(options.path,options.deviceId,[{...record('protected'),state:'succeeded'}]);
  try{const db=new DatabaseSync(options.path);try{if(version===1)db.exec('CREATE TABLE foreign_data (value TEXT);');else db.exec('PRAGMA user_version=7');}finally{db.close();}const before=await readFile(options.path);await assert.rejects(HostRecoveryJournal.open(options),/schema/);assert.deepEqual(await readFile(options.path),before);}finally{await rm(root,{recursive:true,force:true});}
 }
});
test('failed admission rolls back standard receipt expiration and cannot expire a pending operation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'recovery-expire-')),options={path:join(root,'recovery.db'),deviceId:'printer'};let opened=await HostRecoveryJournal.open(options);
 try{
  for(let i=0;i<64;i++)await finish(opened.journal,record('old-'+i,true));await opened.journal.save(record('controlled-pending'));
  await assert.rejects(opened.journal.save(record('candidate',true)),/UNIQUE/);await opened.journal.close();opened=await HostRecoveryJournal.open(options);
  assert.equal(opened.records.filter(r=>r.kind==='restart').length,64);assert.equal(opened.records.find(r=>r.request_id==='old-0')?.state,'succeeded');assert.equal(opened.records.find(r=>r.request_id==='controlled-pending')?.state,'interrupted');assert.equal(opened.records.find(r=>r.request_id==='candidate'),undefined);
  const write=await opened.journal.save(record('new-pending',true));assert.deepEqual(write.expired,['old-0']);await assert.rejects(opened.journal.save(record('second-pending',true)),/UNIQUE/);
  await opened.journal.close();opened=await HostRecoveryJournal.open(options);assert.equal(opened.records.find(r=>r.request_id==='new-pending')?.state,'interrupted');assert.equal(opened.records.find(r=>r.request_id==='old-1')?.state,'succeeded');assert.equal(opened.records.find(r=>r.request_id==='second-pending'),undefined);
 }finally{await opened.journal.close();await rm(root,{recursive:true,force:true});}
});
test('full controlled history never blocks standard restarts, memory and disk retain the same bounded IDs',async t=>{
 const root=await mkdtemp(join(tmpdir(),'recovery-full-')),options={path:join(root,'recovery.db'),deviceId:'printer'};
 const old=Array.from({length:128},(_,i)=>({...record('controlled-'+i),state:'succeeded' as const}));recoveryJournalV1(options.path,options.deviceId,old);
 let control=new ProductHostControl(),calls=0;const ids:string[]=[];
 try{
  await control.configure(options);control.attach(async()=>{calls++;});const token=control.status.state_token;
  await assert.rejects(control.request('controlled-new',token,()=>assert.fail()),/capacity/);assert.equal(control.status.storage_failed,false);
  for(let i=0;i<150;i++){const admitted=await control.requestRestart(undefined,undefined,cb=>cb(true));ids.push(admitted.request_id);await settled(control);assert.equal(control.operation(admitted.request_id)?.state,'succeeded');assert.equal(control.status.recovery_history.standard_restart.retained,Math.min(i+1,64));}
  assert.equal(calls,150);assert.equal(control.status.storage_failed,false);assert.equal(control.operation(ids[0]),null);assert.equal(control.operation(ids.at(-64)!)?.state,'succeeded');
  await assert.rejects(control.request(ids[0],token,()=>assert.fail()),/reserved/);assert.equal((await control.request('controlled-0','original-token',()=>assert.fail())).state,'succeeded');assert.equal(control.status.recovery_history.controlled.retained,128);
  await control.close();const opened=await HostRecoveryJournal.open(options);try{assert.equal(opened.records.length,192);assert.deepEqual(opened.records.filter(r=>r.kind==='restart').map(r=>r.request_id),ids.slice(-64));assert.deepEqual(opened.records.filter(r=>!r.kind),old);}finally{await opened.journal.close();}
  control=new ProductHostControl();await control.configure(options);assert.equal(control.status.restart_operation?.request_id,ids.at(-1));control.attach(async()=>{calls++;});await assert.rejects(control.request(ids.at(-1)!,'original-token',()=>assert.fail()),/conflicts/);await control.requestRestart(undefined,undefined,cb=>cb(true));await settled(control);assert.equal(calls,151);assert.equal(control.status.recovery_history.standard_restart.retained,64);t.diagnostic('128 migrated controlled receipts preserved; 151 standard requests admitted and settled; memory/disk bounded to 64 standard receipts.');
 }finally{await control.close();await rm(root,{recursive:true,force:true});}
});
test('in-memory control uses the same standard bounds without losing controlled idempotency',async()=>{
 const control=new ProductHostControl();let calls=0;control.attach(async()=>{calls++;});const token=control.status.state_token;const old=await control.request('controlled',token,cb=>cb(true));await settled(control);const ids:string[]=[];
 try{for(let i=0;i<140;i++){ids.push((await control.requestRestart(undefined,undefined,cb=>cb(true))).request_id);await settled(control);}assert.equal(control.status.recovery_history.standard_restart.retained,64);assert.equal(control.operation(ids[0]),null);assert.equal((await control.request(old.request_id,token,()=>assert.fail())).state,'succeeded');assert.equal(calls,141);}finally{await control.close();}
});
test('SIGKILL after expiration and queued admission restores the latest standard outcome without replay',async()=>{
 const root=await mkdtemp(join(tmpdir(),'recovery-retention-kill-')),options={path:join(root,'recovery.db'),deviceId:'printer'};let control:ProductHostControl|undefined;
 try{
  const source=`import {HostRecoveryJournal} from ${JSON.stringify(new URL('../src/runtime/host-recovery-journal.ts',import.meta.url).href)};const {journal}=await HostRecoveryJournal.open(${JSON.stringify(options)});for(let i=0;i<64;i++){const r={request_id:'restart-old-'+i,state_token:'original-token',kind:'restart',state:'queued',error:null};await journal.save(r);await journal.save({...r,state:'running'});await journal.save({...r,state:'succeeded'});}await journal.save({request_id:'restart-crashed',state_token:'original-token',kind:'restart',state:'queued',error:null});process.kill(process.pid,'SIGKILL');`;
  assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',source],{stdio:'pipe',timeout:15000}),error=>(error as NodeJS.ErrnoException&{signal?:string}).signal==='SIGKILL');
  control=new ProductHostControl();await control.configure(options);let calls=0;control.attach(async()=>{calls++;});assert.equal(control.status.restart_operation?.request_id,'restart-crashed');assert.equal(control.status.restart_operation?.state,'interrupted');assert.equal(control.operation('restart-old-0'),null);assert.equal(control.status.recovery_history.standard_restart.retained,64);assert.equal(calls,0);await control.requestRestart(undefined,undefined,cb=>cb(true));await settled(control);assert.equal(calls,1);assert.equal(control.operation('restart-crashed')?.state,'interrupted');
 }finally{await control?.close();await rm(root,{recursive:true,force:true});}
});
test('SIGKILL with queued firmware restart restores its separate interrupted receipt without reset replay',async()=>{
 const root=await mkdtemp(join(tmpdir(),'firmware-retention-kill-')),options={path:join(root,'recovery.db'),deviceId:'printer'};let control:ProductHostControl|undefined;
 try{
  const source=`import {HostRecoveryJournal} from ${JSON.stringify(new URL('../src/runtime/host-recovery-journal.ts',import.meta.url).href)};const {journal}=await HostRecoveryJournal.open(${JSON.stringify(options)});await journal.save({request_id:'firmware-restart-crashed',state_token:'original-token',kind:'firmware_restart',state:'queued',error:null});process.kill(process.pid,'SIGKILL');`;
  assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',source],{stdio:'pipe',timeout:15000}),e=>(e as {signal?:string}).signal==='SIGKILL');control=new ProductHostControl();await control.configure(options);let calls=0;control.attach(async()=>{calls++;},()=>{},{kinds:['restart','firmware_restart']});assert.equal(control.status.firmware_restart_operation?.state,'interrupted');assert.equal(control.status.restart_operation,null);assert.equal(calls,0);await control.requestFirmwareRestart(undefined,undefined,cb=>cb(true));await settled(control);assert.equal(calls,1);assert.equal(control.operation('firmware-restart-crashed')?.state,'interrupted');
 }finally{await control?.close();await rm(root,{recursive:true,force:true});}
});
