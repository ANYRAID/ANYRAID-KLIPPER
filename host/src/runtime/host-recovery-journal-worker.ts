import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {openSync,closeSync,fstatSync,constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import type {RecoveryJournalOptions,RecoveryRecord} from './host-recovery-journal.ts';
const options=workerData as RecoveryJournalOptions,port=parentPort!,app=0x41524852;
const schema="CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1),device_id TEXT NOT NULL) STRICT;CREATE TABLE operations (id TEXT PRIMARY KEY,token TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','interrupted')),error TEXT) STRICT;CREATE UNIQUE INDEX pending_operation ON operations((1)) WHERE state IN ('queued','running');";
const normalized=(s:string)=>s.replace(/\s+/g,' ').trim();const valid=(s:unknown)=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(s);
const states=['queued','running','succeeded','failed','interrupted'];let db:DatabaseSync|undefined;
function checked(value:unknown):RecoveryRecord{const r=value as RecoveryRecord;if(!r||typeof r!=='object'||Object.keys(r).some(k=>!['request_id','state_token','state','error'].includes(k))||!valid(r.request_id)||!valid(r.state_token)||!states.includes(r.state)||r.error!==null&&(typeof r.error!=='string'||r.error.length>256))throw new Error('Invalid recovery record');return {request_id:r.request_id,state_token:r.state_token,state:r.state,error:r.error};}
function row(r:Record<string,unknown>):RecoveryRecord{return checked({request_id:r.id,state_token:r.token,state:r.state,error:r.error});}
function transaction<T>(action:()=>T):T{db!.exec('BEGIN IMMEDIATE');try{const result=action();db!.exec('COMMIT');return result;}catch(error){try{db!.exec('ROLLBACK');}catch{}throw error;}}
function initialize(){
 if(!options||!isAbsolute(options.path)||options.path.includes('\0')||!valid(options.deviceId))throw new Error('Invalid recovery journal identity');
 const fd=openSync(options.path,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size>1024*1024)throw new Error('Invalid recovery journal file');}finally{closeSync(fd);}
 db=new DatabaseSync(options.path,{enableForeignKeyConstraints:true,allowExtension:false});db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0');
 const version=Number(db.prepare('PRAGMA user_version').get()!.user_version),identity=Number(db.prepare('PRAGMA application_id').get()!.application_id),tables=db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
 if(!(version===0&&identity===0&&tables.length===0||version===1&&identity===app))throw new Error('Unknown recovery journal schema');
 if(version===1&&JSON.stringify(tables.map(r=>normalized(String(r.sql))).sort())!==JSON.stringify(schema.split(';').filter(Boolean).map(normalized).sort()))throw new Error('Recovery schema mismatch');
 db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=EXTRA; PRAGMA journal_mode=DELETE');const pageSize=Number(db.prepare('PRAGMA page_size').get()!.page_size);db.exec(`PRAGMA max_page_count=${Math.floor(1024*1024/pageSize)}`);
 return transaction(()=>{
  if(!version){db!.exec(schema+`PRAGMA application_id=${app}; PRAGMA user_version=1;`);db!.prepare('INSERT INTO metadata VALUES(1,?)').run(options.deviceId);}
  if(db!.prepare('PRAGMA quick_check').get()!.quick_check!=='ok'||db!.prepare('SELECT device_id FROM metadata WHERE id=1').get()?.device_id!==options.deviceId)throw new Error('Recovery journal integrity or device mismatch');
  const records=db!.prepare('SELECT id,token,state,error FROM operations').all().map(row);if(records.length>128)throw new Error('Recovery history capacity exceeded');
  db!.exec("UPDATE operations SET state='interrupted',error='Process ended before acknowledged recovery completion' WHERE state IN ('queued','running')");return db!.prepare('SELECT id,token,state,error FROM operations').all().map(row);
 });
}
function save(value:unknown){const next=checked(value);return transaction(()=>{const found=db!.prepare('SELECT id,token,state,error FROM operations WHERE id=?').get(next.request_id);if(found){const old=row(found);if(old.state_token!==next.state_token)throw new Error('Recovery identity conflicts');if(JSON.stringify(old)===JSON.stringify(next))return old;const allowed=old.state==='queued'?['running','failed']:old.state==='running'?['succeeded','failed']:[];if(!allowed.includes(next.state))throw new Error('Invalid recovery transition');db!.prepare('UPDATE operations SET state=?,error=? WHERE id=?').run(next.state,next.error,next.request_id);}else{if(next.state!=='queued')throw new Error('Recovery must start queued');if(Number(db!.prepare('SELECT count(*) AS n FROM operations').get()!.n)>=128)throw new Error('Recovery history capacity exceeded');db!.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(next.request_id,next.state_token,next.state,next.error);}return next;});}
try{port.postMessage({ready:true,records:initialize()});port.on('message',({id,method,args})=>{try{if(method==='close'){db!.close();db=undefined;port.postMessage({id,value:null});port.close();return;}if(method!=='save')throw new Error('Unknown recovery operation');port.postMessage({id,value:save(args[0])});}catch(error){port.postMessage({id,error:error instanceof Error?error.message:String(error)});}});}catch(error){try{db?.close();}catch{}port.postMessage({ready:false,error:error instanceof Error?error.message:String(error)});port.close();}
