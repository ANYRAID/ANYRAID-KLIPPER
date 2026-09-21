import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {HistoryRepository} from '../src/moonraker/history-repository.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
async function fixture(run:(db:DatabaseStore,path:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'history-'));const path=join(dir,'db');let db:DatabaseStore|undefined;try{db=await DatabaseStore.open({path});await run(db,path);}finally{await db?.close();await rm(dir,{recursive:true,force:true});}}
const start={filename:'part.gcode',start_time:100,total_duration:2,print_duration:1,filament_used:2.675,metadata:{modified:99,large:1e20},auxiliary_data:[]};
test('history start and concurrent duplicate finish commit one durable total',()=>fixture(async(db,path)=>{
 let history=await HistoryRepository.open(db);await db.sealTableRegistration();const first=await history.start(start);assert.equal(first.job_id,'000001');assert.deepEqual(first.metadata,start.metadata);
 const stats={...start,total_duration:30,print_duration:25,filament_used:3.125};
 const [a,b]=await Promise.all([history.finish(first.job_id,'completed',stats,130),history.finish(first.job_id,'completed',stats,130)]);
 assert.deepEqual(a,b);assert.equal(a.status,'completed');assert.deepEqual(await history.totals(),{total_jobs:1,total_time:30,total_print_time:25,total_filament_used:3.125,longest_job:30,longest_print:25});
 await db.close();const reopened=await DatabaseStore.open({path});try{history=await HistoryRepository.open(reopened);assert.deepEqual(await history.get('1'),a);assert.equal((await history.totals()).total_jobs,1);}finally{await reopened.close();}
}));
test('reopen marks pending history interrupted without inventing finish statistics',()=>fixture(async(db,path)=>{
 const history=await HistoryRepository.open(db),first=await history.start(start);await db.close();const reopened=await DatabaseStore.open({path});try{const next=await HistoryRepository.open(reopened),job=await next.get(first.job_id);assert.equal(job.status,'interrupted');assert.equal(job.end_time,null);assert.equal((await next.totals()).total_jobs,0);}finally{await reopened.close();}
}));
test('history listing follows strict time filters, order and nonpositive limit semantics',()=>fixture(async db=>{
 const history=await HistoryRepository.open(db);
 for(let i=0;i<3;i++){const j=await history.start({...start,start_time:100+i});await history.finish(j.job_id,'completed',start,200+i);}
 assert.deepEqual((await history.list()).jobs.map(j=>j.job_id),['000003','000002','000001']);
 assert.deepEqual((await history.list({since:100,before:202,order:'asc'})).jobs.map(j=>j.job_id),['000002']);
 assert.equal((await history.list({limit:0,start:999})).count,3);assert.equal((await history.list({limit:1,start:1})).jobs[0].job_id,'000002');
 await assert.rejects(history.get('bad!'),e=>e instanceof ApiError&&e.status===400);
}));
test('reset or changed printer statistics cannot overwrite the previous job duration',()=>fixture(async db=>{
 const history=await HistoryRepository.open(db),first=await history.start(start);
 const job=await history.finish(first.job_id,'cancelled',{...start,total_duration:0,filament_used:999},140);
 assert.equal(job.total_duration,2);assert.equal(job.filament_used,2.675);
}));
test('legacy data is rejected without deleting records and invalid start cannot leave a job',()=>fixture(async db=>{
 await db.insert('history','old',{filename:'keep'});await assert.rejects(HistoryRepository.open(db),e=>e instanceof ApiError&&e.status===409);assert.deepEqual(await db.get('history','old'),{filename:'keep'});
 await db.clearNamespace('history');const history=await HistoryRepository.open(db);
 await assert.rejects(history.start({...start,metadata:[] as unknown as Record<string,never>}),e=>e instanceof ApiError&&e.status===400);
 assert.equal((await history.list()).count,0);
}));
test('totals overflow rolls the completed status back with all totals',()=>fixture(async db=>{
 const history=await HistoryRepository.open(db);await db.sql(['job_totals'],[{sql:"UPDATE job_totals SET total=? WHERE field='total_time'",params:[{real:1e308}]}]);
 const first=await history.start(start);await assert.rejects(history.finish(first.job_id,'completed',{...start,total_duration:1e308},200),e=>e instanceof ApiError&&e.status===422);
 assert.equal((await history.get(first.job_id)).status,'in_progress');assert.equal((await history.totals()).total_jobs,0);
}));
test('missing totals abort completion inside the transaction rather than losing accounting',()=>fixture(async db=>{
 const history=await HistoryRepository.open(db),first=await history.start(start);
 await db.sql(['job_totals'],[{sql:"DELETE FROM job_totals WHERE field='longest_job'"}]);
 await assert.rejects(history.finish(first.job_id,'completed',start,200),e=>e instanceof ApiError&&e.status===409);
 assert.equal((await history.get(first.job_id)).status,'in_progress');
 assert.equal((await db.sql(['job_totals'],[{sql:"SELECT total FROM job_totals WHERE field='total_jobs'"}]))[0].rows[0][0],0);
}));
test('history table prototypes and filtered lists match pinned upstream handlers',()=>fixture(async db=>{
 const history=await HistoryRepository.open(db),rows=[];
 for(let i=0;i<3;i++){const created=await history.start({...start,start_time:100+i,metadata:{}});await history.finish(created.job_id,'completed',start,200+i);rows.push({id:i+1,start:100+i,end:200+i});}
 const queries=[{},{since:100,before:202,order:'asc'},{limit:0,start:999},{limit:1,start:1}];
 const {execFileSync}=await import('node:child_process'),{historyOracle}=await import('./helpers/history-oracle.ts'),{historyTables}=await import('../src/moonraker/history-repository.ts');
 const reference=JSON.parse(execFileSync('/usr/bin/python3',['-c',historyOracle()],{input:JSON.stringify({rows,queries}),encoding:'utf8'}));
 assert.deepEqual(reference.prototypes,historyTables.map(t=>t.prototype));
 for(let i=0;i<queries.length;i++){const actual=await history.list(queries[i]);assert.deepEqual({...actual,jobs:actual.jobs.map(j=>({...j,exists:false}))},reference.results[i]);}
}));
test('corrupt numeric totals and exhausted exact job counts cannot silently change accounting',()=>fixture(async db=>{
 const history=await HistoryRepository.open(db),first=await history.start(start);
 await db.sql(['job_totals'],[{sql:"UPDATE job_totals SET total='corrupt' WHERE field='total_time'"}]);
 await assert.rejects(history.finish(first.job_id,'completed',start,200),e=>e instanceof ApiError&&e.status===409);
 assert.equal((await history.get(first.job_id)).status,'in_progress');
 await db.sql(['job_totals'],[{sql:"UPDATE job_totals SET total=0 WHERE field='total_time'"},{sql:"UPDATE job_totals SET total=? WHERE field='total_jobs'",params:[Number.MAX_SAFE_INTEGER]}]);
 await assert.rejects(history.finish(first.job_id,'completed',start,200),e=>e instanceof ApiError&&e.status===409);
 assert.equal((await history.get(first.job_id)).status,'in_progress');assert.equal((await history.totals()).total_jobs,Number.MAX_SAFE_INTEGER);
}));
