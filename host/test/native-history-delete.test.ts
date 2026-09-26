import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {PrintController} from '../src/operations/print.ts';
const request={version:1 as const,requestId:'job',fileId:'file',nozzle:0,bed:0};
test('history removal is atomic, terminal-only and retains requests, statistics and replay protection after restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'history-delete-')),options={path:join(dir,'journal.db'),deviceId:'printer'};let journal=await PrintJournal.open(options);
 try{
  await journal.reserve(request);await assert.rejects(journal.historyDelete('1'),/unfinished/);await journal.transition('job',1,'cancelled',{totalDuration:1,printDuration:0,filamentUsed:0});
  await journal.reserve({...request,requestId:'active'});await assert.rejects(journal.historyDelete('',true),/unfinished/);assert.equal((await journal.historyList()).length,2);assert((await journal.historyGet('1'))!==null);
  assert.deepEqual(await journal.historyDelete('1'),{deleted_jobs:['1']});assert.equal(await journal.historyGet('1'),null);assert.deepEqual((await journal.get('job'))!.statistics,{totalDuration:1,printDuration:0,filamentUsed:0});assert.equal((await journal.scan()).records.length,2);await assert.rejects(journal.historyDelete('1'),/Unknown/);
  await journal.transition('active',1,'cancelled');assert.deepEqual(await journal.historyDelete('',true),{deleted_jobs:['000002']});assert.deepEqual(await journal.historyDelete('',true),{deleted_jobs:[]});
  await journal.close();journal=await PrintJournal.open(options);assert.deepEqual(await journal.historyList(),[]);assert.equal((await journal.reserve(request)).created,false);
  let effects=0;const controller=await PrintController.restore({async prepare(){effects++;},async start(){effects++;},async pause(){},async resume(){},async finish(){},async stop(){}},{maxNozzle:300,maxBed:120},{},{journal});
  try{await assert.rejects(controller.start(request),/reconciliation/);assert.equal(effects,0);assert.equal((await journal.get('job'))!.state,'cancelled');}finally{await controller.retire();}
 }finally{await journal.close();await rm(dir,{recursive:true,force:true});}
});
test('schema three upgrade creates visibility state without hiding old records',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'history-upgrade-')),options={path:join(dir,'journal.db'),deviceId:'printer'};let journal=await PrintJournal.open(options);
 try{await journal.reserve(request);await journal.transition('job',1,'cancelled');const original=await journal.get('job');await journal.close();const old=new DatabaseSync(options.path);old.exec('DROP TABLE history_hidden; PRAGMA user_version=3;');old.close();journal=await PrintJournal.open(options);assert.deepEqual(await journal.get('job'),original);assert.equal((await journal.historyList()).length,1);await journal.historyDelete('1');assert.equal((await journal.historyList()).length,0);}finally{await journal.close();await rm(dir,{recursive:true,force:true});}
});
