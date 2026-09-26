import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {PrintController} from '../src/operations/print.ts';
import {ExtrusionAccounting} from '../src/gcode/extrusion-accounting.ts';
const request={version:1 as const,requestId:'job',fileId:'file',nozzle:0,bed:0};
const snapshot={totalDuration:20,printDuration:12,filamentUsed:-.25};
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'print-statistics-'));return {dir,options:{path:join(dir,'journal.db'),deviceId:'printer'}};}
test('terminal statistics are validated, atomically versioned, immutable on acknowledgement and durable across reopen',async()=>{
 const f=await fixture();let journal=await PrintJournal.open(f.options);
 try{
  await journal.reserve(request);
  await assert.rejects(journal.transition('job',1,'started',snapshot),/terminal outcome/);
  for(const bad of [{...snapshot,totalDuration:-1},{...snapshot,printDuration:21},{...snapshot,filamentUsed:Infinity},{...snapshot,other:1}])await assert.rejects(journal.transition('job',1,'failed',bad));
  assert.equal((await journal.get('job'))?.revision,1);
  const failed=await journal.transition('job',1,'failed',snapshot);assert.deepEqual(failed.statistics,snapshot);
  await assert.rejects(journal.transition('job',1,'cancelled',{...snapshot,totalDuration:99}),/revision/);
  await journal.close();journal=await PrintJournal.open(f.options);const active=(await journal.active())!;assert.equal(active.state,'interrupted');assert.deepEqual(active.statistics,snapshot);
  const cancelled=await journal.transition('job',active.revision,'cancelled',{totalDuration:null,printDuration:null,filamentUsed:null});assert.deepEqual(cancelled.statistics,snapshot);
  await journal.close();journal=await PrintJournal.open(f.options);assert.deepEqual((await journal.get('job'))?.statistics,snapshot);assert.equal((await journal.reserve(request)).created,false);
 }finally{await journal.close();await rm(f.dir,{recursive:true,force:true});}
});
const oldSchema="CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1),device_id TEXT NOT NULL) STRICT;CREATE TABLE requests (id TEXT PRIMARY KEY,request TEXT NOT NULL CHECK(length(request)<=2048),state TEXT NOT NULL CHECK(state IN ('reserved','started','completed','cancelled','failed','interrupted')),revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991)) STRICT;CREATE UNIQUE INDEX one_active ON requests((1)) WHERE state NOT IN ('completed','cancelled');";
test('version one journals migrate without inventing statistics and wrong device migration rolls back',async()=>{
 const f=await fixture();let db=new DatabaseSync(f.options.path);db.exec(oldSchema+'PRAGMA application_id=0x4152504a;PRAGMA user_version=1;');db.prepare('INSERT INTO metadata VALUES(1,?)').run('printer');db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run('job',JSON.stringify(request),'completed',3);db.close();
 try{
  await assert.rejects(PrintJournal.open({...f.options,deviceId:'wrong'}),/different device/);db=new DatabaseSync(f.options.path);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,1);db.close();
  const journal=await PrintJournal.open(f.options);try{assert.deepEqual(await journal.get('job'),{request,state:'completed',revision:3});await journal.reserve({...request,requestId:'new'});await journal.transition('new',1,'cancelled',snapshot);}finally{await journal.close();}
  db=new DatabaseSync(f.options.path);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,3);assert.equal(db.prepare('SELECT count(*) AS n FROM request_statistics').get()!.n,1);db.close();
 }finally{await rm(f.dir,{recursive:true,force:true});}
});
test('controller freezes live and durable counters at device completion and they survive a new process owner',async t=>{
 let now=0;t.mock.method(performance,'now',()=>now);const f=await fixture();let journal=await PrintJournal.open(f.options);const meter=new ExtrusionAccounting();
 const controller=new PrintController({async prepare(){},async start(){},async pause(){},async resume(){},async finish(){now=10000;},async stop(){}},{maxNozzle:300,maxBed:120},{},{journal,extrusionAccounting:meter});
 try{
  await controller.start(request);now=2000;meter.accepted(0,4,1);now=5000;await controller.pause();now=7000;await controller.resume();await controller.complete('job');
  const expected={totalDuration:10,printDuration:6,filamentUsed:4};assert.deepEqual((await controller.requestRecord('job'))?.statistics,expected);now=20000;assert.equal(controller.totalDuration,10);assert.equal(controller.printDuration,6);
  await controller.retire();await journal.close();journal=await PrintJournal.open(f.options);assert.deepEqual((await journal.get('job'))?.statistics,expected);
 }finally{await controller.retire();await journal.close();await rm(f.dir,{recursive:true,force:true});}
});
