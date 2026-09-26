import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {emptyHistoryTotals,addHistoryTotals,historyTotalsView,decodeHistoryTotals} from '../src/operations/print-history-totals.ts';
const request={version:1 as const,requestId:'job',fileId:'file',nozzle:0,bed:0};
test('native totals count outcomes once, survive hide/reset/restart and reject resetting unfinished work',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'history-totals-')),options={path:join(dir,'jobs.db'),deviceId:'printer'};let journal=await PrintJournal.open(options);
 try{
  assert.equal((await journal.historyTotals()).job_totals.total_jobs,0);await journal.reserve(request);await assert.rejects(journal.historyResetTotals(),/unfinished/);
  await journal.transition('job',1,'failed',{totalDuration:10,printDuration:8,filamentUsed:3});await journal.historyDelete('1');const totals=await journal.historyTotals();assert.deepEqual(totals.job_totals,{total_jobs:1,total_time:10,total_print_time:8,total_filament_used:3,longest_job:10,longest_print:8});
  assert.deepEqual((await journal.historyResetTotals()).last_totals,totals.job_totals);await journal.transition('job',2,'cancelled');assert.equal((await journal.historyTotals()).job_totals.total_jobs,0);
  await journal.reserve({...request,requestId:'next'});await journal.transition('next',1,'cancelled',{totalDuration:2,printDuration:1,filamentUsed:-1});const expected=await journal.historyTotals();assert.equal(expected.job_totals.total_jobs,1);assert.equal(expected.job_totals.total_filament_used,-1);await journal.close();journal=await PrintJournal.open(options);assert.deepEqual(await journal.historyTotals(),expected);assert.equal((await journal.reserve(request)).created,false);
  await journal.reserve({...request,requestId:'unknown'});await journal.transition('unknown',1,'cancelled');const unknown=await journal.historyTotals();assert.equal(unknown.job_totals.total_jobs,2);assert.equal(unknown.job_totals.total_time,null);assert.equal(unknown.job_totals.longest_job,null);assert.equal(unknown.native_unknown.total_duration,1);
 }finally{await journal.close();await rm(dir,{recursive:true,force:true});}
});
test('version four migration reconstructs hidden known and missing outcomes exactly once',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'history-totals-upgrade-')),options={path:join(dir,'jobs.db'),deviceId:'printer'};let journal=await PrintJournal.open(options);
 try{
  await journal.reserve(request);await journal.transition('job',1,'cancelled',{totalDuration:5,printDuration:3,filamentUsed:2});await journal.historyDelete('1');await journal.reserve({...request,requestId:'old'});await journal.transition('old',1,'cancelled');await journal.close();
  const old=new DatabaseSync(options.path);old.exec('DROP TABLE history_totals; DROP TABLE history_counted; PRAGMA user_version=4;');old.close();journal=await PrintJournal.open(options);const totals=await journal.historyTotals();assert.equal(totals.job_totals.total_jobs,2);assert.equal(totals.job_totals.total_time,null);assert.equal(totals.native_unknown.total_duration,1);assert.equal((await journal.historyList()).length,1);await journal.close();journal=await PrintJournal.open(options);assert.deepEqual(await journal.historyTotals(),totals);
 }finally{await journal.close();await rm(dir,{recursive:true,force:true});}
});
test('compensated sums retain small increments; unknown inputs and overflow remain explicit',()=>{
 const state=emptyHistoryTotals();addHistoryTotals(state,{totalDuration:1e16,printDuration:0,filamentUsed:1e16});for(let i=0;i<2;i++)addHistoryTotals(state,{totalDuration:1,printDuration:0,filamentUsed:1});assert.equal(historyTotalsView(state).job_totals.total_time,10000000000000002);assert.deepEqual(decodeHistoryTotals(JSON.stringify(state)),state);
 const overflow=emptyHistoryTotals();for(let i=0;i<2;i++)addHistoryTotals(overflow,{totalDuration:1e308,printDuration:0,filamentUsed:-1e308});const result=historyTotalsView(overflow);assert.equal(result.job_totals.total_time,null);assert.equal(result.job_totals.total_filament_used,null);assert.equal(result.job_totals.longest_job,1e308);assert.deepEqual(result.native_overflow,['total_time','total_filament_used']);assert.throws(()=>decodeHistoryTotals('{}'),/Invalid/);
});
