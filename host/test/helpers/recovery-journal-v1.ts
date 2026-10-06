import {DatabaseSync} from 'node:sqlite';
import type {RecoveryRecord} from '../../src/runtime/host-recovery-journal.ts';
/** Historical format fixture, independent of the current worker schema. */
export function recoveryJournalV1(path:string,deviceId:string,records:readonly RecoveryRecord[]){
 const db=new DatabaseSync(path);
 try{
  db.exec("CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1),device_id TEXT NOT NULL) STRICT;CREATE TABLE operations (id TEXT PRIMARY KEY,token TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','interrupted')),error TEXT) STRICT;CREATE UNIQUE INDEX pending_operation ON operations((1)) WHERE state IN ('queued','running'); PRAGMA application_id=1095911506; PRAGMA user_version=1;");
  db.prepare('INSERT INTO metadata VALUES(1,?)').run(deviceId);
  const insert=db.prepare('INSERT INTO operations VALUES(?,?,?,?)');
  for(const r of records)insert.run(r.request_id,r.state_token,r.state,r.error);
 }finally{db.close();}
}
/** Exact historical v2 fixture; independent of the current worker schema. */
export function recoveryJournalV2(path:string,deviceId:string,records:readonly RecoveryRecord[]){
 const db=new DatabaseSync(path);try{
  db.exec("CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1),device_id TEXT NOT NULL) STRICT;CREATE TABLE operations (id TEXT PRIMARY KEY,token TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','interrupted')),error TEXT,kind TEXT NOT NULL CHECK(kind IN ('reinitialize','restart'))) STRICT;CREATE UNIQUE INDEX pending_operation ON operations((1)) WHERE state IN ('queued','running'); PRAGMA application_id=1095911506; PRAGMA user_version=2;");
  db.prepare('INSERT INTO metadata VALUES(1,?)').run(deviceId);const insert=db.prepare('INSERT INTO operations VALUES(?,?,?,?,?)');for(const r of records)insert.run(r.request_id,r.state_token,r.state,r.error,r.kind??'reinitialize');
 }finally{db.close();}
}
/** Exact historical v3 fixture; no current schema generator is reused. */
export function recoveryJournalV3(path:string,deviceId:string,records:readonly RecoveryRecord[]){
 const db=new DatabaseSync(path);try{
  db.exec("CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1),device_id TEXT NOT NULL) STRICT;CREATE TABLE operations (id TEXT PRIMARY KEY,token TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','interrupted')),error TEXT,kind TEXT NOT NULL CHECK(kind IN ('reinitialize','restart','firmware_restart'))) STRICT;CREATE UNIQUE INDEX pending_operation ON operations((1)) WHERE state IN ('queued','running'); PRAGMA application_id=1095911506; PRAGMA user_version=3;");
  db.prepare('INSERT INTO metadata VALUES(1,?)').run(deviceId);const insert=db.prepare('INSERT INTO operations VALUES(?,?,?,?,?)');for(const r of records)insert.run(r.request_id,r.state_token,r.state,r.error,r.kind??'reinitialize');
 }finally{db.close();}
}
