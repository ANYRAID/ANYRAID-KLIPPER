import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {PrintJournal} from '../src/operations/print-journal.ts';
const request={version:1 as const,requestId:'job',fileId:'file',nozzle:0,bed:0};
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'journal-scan-'));return {dir,options:{path:join(dir,'journal.db'),deviceId:'printer'}};}
test('reservation and outcome timestamps commit with state and retain the first outcome across recovery',async()=>{
 const f=await fixture(),before=Date.now()/1000;let journal=await PrintJournal.open(f.options);
 try{
  const reserved=(await journal.reserve(request)).record;assert(reserved.timestamps!.reservedAt!>=before);assert.equal(reserved.timestamps!.startedAt,null);assert.equal(reserved.timestamps!.endedAt,null);
  assert.deepEqual((await journal.reserve(request)).record.timestamps,reserved.timestamps);
  const started=await journal.transition('job',1,'started');assert(started.timestamps!.startedAt!>=reserved.timestamps!.reservedAt!);
  const failed=await journal.transition('job',2,'failed');assert(failed.timestamps!.endedAt!>=started.timestamps!.startedAt!);assert(failed.timestamps!.endedAt!<=Date.now()/1000);
  await journal.close();journal=await PrintJournal.open(f.options);const recovered=(await journal.active())!;assert.equal(recovered.state,'interrupted');assert.deepEqual(recovered.timestamps,failed.timestamps);assert.deepEqual((await journal.transition('job',recovered.revision,'cancelled')).timestamps,failed.timestamps);
 }finally{await journal.close();await rm(f.dir,{recursive:true,force:true});}
});
test('bounded lexical scan preserves records, leaves live state intact and a new scan sees earlier insertions',async()=>{
 const f=await fixture(),journal=await PrintJournal.open(f.options);
 try{
  for(const id of ['c','a','z','b','Z']){await journal.reserve({...request,requestId:id});await journal.transition(id,1,'cancelled');}
  const first=await journal.scan(undefined,2);assert.deepEqual(first.records.map(r=>r.request.requestId),['Z','a']);assert.equal(first.nextAfter,'a');
  await journal.reserve({...request,requestId:'A'}); // Active job must remain active during every scan.
  const second=await journal.scan(first.nextAfter!,2),third=await journal.scan(second.nextAfter!,2);assert.deepEqual(second.records.map(r=>r.request.requestId),['b','c']);assert.deepEqual(third.records.map(r=>r.request.requestId),['z']);assert.equal(third.nextAfter,null);
  const all=await journal.scan();assert.deepEqual(all.records.map(r=>r.request.requestId),['A','Z','a','b','c','z']);assert.equal((await journal.active())!.request.requestId,'A');assert.equal((await journal.get('A'))!.revision,1);
  first.records[0].timestamps!.reservedAt=0;assert.notEqual((await journal.get('Z'))!.timestamps!.reservedAt,0);
  for(const limit of [0,-1,257,1.5,NaN])await assert.rejects(journal.scan(undefined,limit));await assert.rejects(journal.scan('bad cursor'));assert.deepEqual(await journal.scan('zz'),{records:[],nextAfter:null});
 }finally{await journal.close();await rm(f.dir,{recursive:true,force:true});}
});
test('schema two migration preserves statistics and does not fabricate old timestamps',async()=>{
 const f=await fixture();let journal=await PrintJournal.open(f.options);const statistics={totalDuration:3,printDuration:2,filamentUsed:1};
 try{
  await journal.reserve(request);await journal.transition('job',1,'failed',statistics);await journal.close();
  const old=new DatabaseSync(f.options.path);old.exec('DROP TABLE history_hidden; DROP TABLE request_times; PRAGMA user_version=2;');old.close();
  journal=await PrintJournal.open(f.options);const record=(await journal.active())!;assert.equal(record.timestamps,undefined);assert.deepEqual(record.statistics,statistics);
  const confirmed=await journal.transition('job',record.revision,'cancelled');assert.equal(confirmed.timestamps,undefined);assert.deepEqual(confirmed.statistics,statistics);
 }finally{await journal.close();await rm(f.dir,{recursive:true,force:true});}
});
