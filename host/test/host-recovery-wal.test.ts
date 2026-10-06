import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,stat,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HostRecoveryJournal,recoveryCapacity,type RecoveryRecord} from '../src/runtime/host-recovery-journal.ts';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
const terminalError='e'.repeat(256),token='t'.repeat(128),service='s'.repeat(240);
const entry=(id:string):RecoveryRecord=>({request_id:id,state_token:token,state:'queued',error:null,kind:'service_restart',service});
for(const pageSize of [4096,65536])test(`WAL recovery retains bounded full histories and stopped-owner backups (${pageSize}-byte pages)`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'recovery-wal-full-')),options={path:join(root,'recovery.db'),deviceId:'printer'};
 const empty=new DatabaseSync(options.path);try{empty.exec(`PRAGMA page_size=${pageSize}; VACUUM`);}finally{empty.close();}
 let opened=await HostRecoveryJournal.open(options);let peakDatabase=0,peakWal=0;
 try{
  await opened.journal.close();
  // Seed all 640 terminal slots at maximum validated payload lengths. Changes
  // under test are committed through the real worker, including rollover.
  const db=new DatabaseSync(options.path);try{db.exec('BEGIN IMMEDIATE');const insert=db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)');for(const [kind,capacity] of Object.entries(recoveryCapacity))for(let i=0;i<capacity;i++)insert.run((kind+'-'+i).padEnd(128,'x'),token,'failed',terminalError,kind,kind.startsWith('service_')?service:null);db.exec('COMMIT');}finally{db.close();}
  opened=await HostRecoveryJournal.open(options);assert.equal(opened.records.length,640);
  for(let i=0;i<200;i++){
   const r=entry(('replacement-'+i).padEnd(128,'x'));
   for(const state of ['queued','running','failed'] as const){await opened.journal.save({...r,state,error:state==='failed'?terminalError:null});peakDatabase=Math.max(peakDatabase,(await stat(options.path)).size);peakWal=Math.max(peakWal,(await stat(options.path+'-wal')).size);assert(peakDatabase<=1024**2);assert(peakWal<=2*1024**2,'WAL must remain bounded under full-history rollover');}
  }
  await opened.journal.close();const backup=join(root,'stopped-backup.db');await copyFile(options.path,backup);
  const restored=await HostRecoveryJournal.open({...options,path:backup});try{assert.equal(restored.records.length,640);assert.deepEqual(restored.records.find(r=>r.request_id.startsWith('replacement-199')), {...entry('replacement-199'.padEnd(128,'x')),state:'failed',error:terminalError});assert.equal(restored.records.filter(r=>!r.kind).length,128);assert.equal(restored.records.filter(r=>r.kind==='firmware_restart').length,64);}finally{await restored.journal.close();}
  t.diagnostic(JSON.stringify({pageSize,receipts:640,commits:600,peakDatabaseBytes:peakDatabase,peakWalBytes:peakWal,scope:'Software worker rollover and stopped-owner backup; not power-loss or target storage validation'}));
 }finally{await opened.journal.close();await rm(root,{recursive:true,force:true});}
});
test('unclean WAL backup needs both files and restores acknowledged pending work without executing it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'recovery-wal-crash-')),options={path:join(root,'recovery.db'),deviceId:'printer'},r=entry('crashed'),restore=join(root,'restored.db'),control=new ProductHostControl();
 try{
  const source=`import {HostRecoveryJournal} from ${JSON.stringify(new URL('../src/runtime/host-recovery-journal.ts',import.meta.url).href)};const {journal}=await HostRecoveryJournal.open(${JSON.stringify(options)});await journal.save(${JSON.stringify(r)});process.kill(process.pid,'SIGKILL');`;
  assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',source],{stdio:'pipe',timeout:10000}),error=>(error as NodeJS.ErrnoException&{signal?:string}).signal==='SIGKILL');
  assert((await stat(options.path+'-wal')).size>0);const header=await readFile(options.path);assert.equal(header[18],2);assert.equal(header[19],2);
  await copyFile(options.path,restore);await copyFile(options.path+'-wal',restore+'-wal');
  await control.configure({...options,path:restore});let calls=0;control.attach(async()=>{calls++;},()=>{},{kinds:['service_restart']});
  assert.deepEqual(control.operation(r.request_id),{...r,state:'interrupted',error:'Process ended before acknowledged recovery completion'});await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);
 }finally{await control.close();await rm(root,{recursive:true,force:true});}
});
