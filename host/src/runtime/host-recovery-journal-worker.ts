import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {openSync,closeSync,fstatSync,constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {recoveryCapacity,type RecoveryJournalOptions,type RecoveryRecord,type RecoveryWrite} from './host-recovery-journal.ts';
const options=workerData as RecoveryJournalOptions,port=parentPort!,app=0x41524852;
const metadata="CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1),device_id TEXT NOT NULL) STRICT;";
const pending="CREATE UNIQUE INDEX pending_operation ON operations((1)) WHERE state IN ('queued','running');";
const legacySchema=metadata+"CREATE TABLE operations (id TEXT PRIMARY KEY,token TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','interrupted')),error TEXT) STRICT;"+pending;
const schema=metadata+"CREATE TABLE operations (id TEXT PRIMARY KEY,token TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','interrupted')),error TEXT,kind TEXT NOT NULL CHECK(kind IN ('reinitialize','restart'))) STRICT;"+pending;
const normalized=(s:string)=>s.replace(/\s+/g,' ').trim();const valid=(s:unknown)=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(s);
const states=['queued','running','succeeded','failed','interrupted'];let db:DatabaseSync|undefined;
function checked(value:unknown):RecoveryRecord{
 const r=value as RecoveryRecord;
 if(!r||typeof r!=='object'||Object.keys(r).some(k=>!['request_id','state_token','state','error','kind'].includes(k))||!valid(r.request_id)||!valid(r.state_token)||!states.includes(r.state)||r.error!==null&&(typeof r.error!=='string'||r.error.length>256)||r.kind!==undefined&&r.kind!=='restart')throw new Error('Invalid recovery record');
 return {request_id:r.request_id,state_token:r.state_token,state:r.state,error:r.error,...r.kind?{kind:r.kind}:{}};
}
function row(r:Record<string,unknown>):RecoveryRecord{return checked({request_id:r.id,state_token:r.token,state:r.state,error:r.error,...r.kind==='restart'?{kind:'restart'}:{}});}
function transaction<T>(action:()=>T):T{db!.exec('BEGIN IMMEDIATE');try{const result=action();db!.exec('COMMIT');return result;}catch(error){try{db!.exec('ROLLBACK');}catch{}throw error;}}
function initialize(){
 if(!options||!isAbsolute(options.path)||options.path.includes('\0')||!valid(options.deviceId))throw new Error('Invalid recovery journal identity');
 const fd=openSync(options.path,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size>1024*1024)throw new Error('Invalid recovery journal file');}finally{closeSync(fd);}
 db=new DatabaseSync(options.path,{enableForeignKeyConstraints:true,allowExtension:false});db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0');
 const version=Number(db.prepare('PRAGMA user_version').get()!.user_version),identity=Number(db.prepare('PRAGMA application_id').get()!.application_id),tables=db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
 if(!(version===0&&identity===0&&tables.length===0||[1,2].includes(version)&&identity===app))throw new Error('Unknown recovery journal schema');
 const expected=version===1?legacySchema:schema;
 if(version&&JSON.stringify(tables.map(r=>normalized(String(r.sql))).sort())!==JSON.stringify(expected.split(';').filter(Boolean).map(normalized).sort()))throw new Error('Recovery schema mismatch');
 db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=EXTRA; PRAGMA journal_mode=DELETE');const pageSize=Number(db.prepare('PRAGMA page_size').get()!.page_size);db.exec(`PRAGMA max_page_count=${Math.floor(1024*1024/pageSize)}`);
 return transaction(()=>{
  if(version&&(db!.prepare('PRAGMA quick_check').get()!.quick_check!=='ok'||db!.prepare('SELECT device_id FROM metadata WHERE id=1').get()?.device_id!==options.deviceId))throw new Error('Recovery journal integrity or device mismatch');
  if(!version){db!.exec(schema+`PRAGMA application_id=${app}; PRAGMA user_version=2;`);db!.prepare('INSERT INTO metadata VALUES(1,?)').run(options.deviceId);}
  if(version===1){
   const old=db!.prepare('SELECT id,token,state,error FROM operations ORDER BY rowid').all().map(row);if(old.length>recoveryCapacity.reinitialize)throw new Error('Recovery history capacity exceeded');
   // v1 has no reliable operation kind. Preserve every existing receipt as
   // controlled, including names that resemble generated standard IDs.
   db!.exec('DROP INDEX pending_operation; ALTER TABLE operations RENAME TO operations_v1;'+schema.slice(metadata.length)+"INSERT INTO operations(id,token,state,error,kind) SELECT id,token,state,error,'reinitialize' FROM operations_v1 ORDER BY rowid; DROP TABLE operations_v1; PRAGMA user_version=2;");
  }
  for(const kind of ['reinitialize','restart'] as const){if(Number(db!.prepare('SELECT count(*) AS n FROM operations WHERE kind=?').get(kind)!.n)>recoveryCapacity[kind])throw new Error('Recovery history capacity exceeded');}
  const records=db!.prepare('SELECT id,token,state,error,kind FROM operations ORDER BY rowid').all().map(row);
  // Conversion is part of the same migration/open transaction. Never replay.
  db!.exec("UPDATE operations SET state='interrupted',error='Process ended before acknowledged recovery completion' WHERE state IN ('queued','running')");
  return records.map(r=>r.state==='queued'||r.state==='running'?{...r,state:'interrupted' as const,error:'Process ended before acknowledged recovery completion'}:r);
 });
}
function save(value:unknown):RecoveryWrite{
 const next=checked(value),kind=next.kind??'reinitialize';return transaction(()=>{
  const found=db!.prepare('SELECT id,token,state,error,kind FROM operations WHERE id=?').get(next.request_id);
  if(found){
   const old=row(found);if(old.state_token!==next.state_token||old.kind!==next.kind)throw new Error('Recovery identity conflicts');
   if(JSON.stringify(old)===JSON.stringify(next))return {record:old,expired:[]};
   const allowed=old.state==='queued'?['running','failed']:old.state==='running'?['succeeded','failed']:[];
   if(!allowed.includes(next.state))throw new Error('Invalid recovery transition');db!.prepare('UPDATE operations SET state=?,error=? WHERE id=?').run(next.state,next.error,next.request_id);return {record:next,expired:[]};
  }
  if(next.state!=='queued')throw new Error('Recovery must start queued');
  const expired:string[]=[],count=Number(db!.prepare('SELECT count(*) AS n FROM operations WHERE kind=?').get(kind)!.n);
  if(count>=recoveryCapacity[kind]){
   if(kind==='reinitialize')throw new Error('Recovery controlled history capacity exceeded');
   const oldest=db!.prepare("SELECT id FROM operations WHERE kind='restart' AND state NOT IN ('queued','running') ORDER BY rowid LIMIT 1").get();
   if(!oldest)throw new Error('No completed standard recovery receipt can expire');
   expired.push(String(oldest.id));db!.prepare('DELETE FROM operations WHERE id=?').run(oldest.id);
  }
  // A pending operation of either kind violates the single shared index.
  // Its rejection rolls back expiration too, preserving prior receipts.
  db!.prepare('INSERT INTO operations VALUES(?,?,?,?,?)').run(next.request_id,next.state_token,next.state,next.error,kind);return {record:next,expired};
 });
}
try{
 port.postMessage({ready:true,records:initialize()});port.on('message',({id,method,args})=>{try{if(method==='close'){db!.close();db=undefined;port.postMessage({id,value:null});port.close();return;}if(method!=='save')throw new Error('Unknown recovery operation');port.postMessage({id,value:save(args[0])});}catch(error){port.postMessage({id,error:error instanceof Error?error.message:String(error)});}});
}catch(error){try{db?.close();}catch{}port.postMessage({ready:false,error:error instanceof Error?error.message:String(error)});port.close();}
