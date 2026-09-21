import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {HistoryRepository} from '../src/moonraker/history-repository.ts';
import {HistoryRuntime,type HistoryEvent} from '../src/moonraker/history-runtime.ts';
import type {JobChange} from '../src/moonraker/job-state.ts';
const stats={filename:'part.gcode',total_duration:30,print_duration:25,filament_used:2.675};
const change=(event:'started'|'complete'|'cancelled',current=stats,previous=stats):JobChange=>({kind:'state',event,current,previous});
async function fixture(run:(history:HistoryRepository,db:DatabaseStore)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'history-runtime-')),db=await DatabaseStore.open({path:join(dir,'db')});try{await run(await HistoryRepository.open(db),db);}finally{await db.close();await rm(dir,{recursive:true,force:true});}}
test('rapid transitions snapshot inputs and notify only committed rows in order',()=>fixture(async history=>{
 const events:HistoryEvent[]=[],runtime=new HistoryRuntime(history,{clock:()=>100,notify:async event=>{assert.equal((await history.get(event.job.job_id)).status,event.job.status);events.push(event);event.job.filename='changed by notifier';}});
 const input={...stats};runtime.observe(change('started',input));runtime.observe(change('complete',input));input.filename='changed by caller';await runtime.drain();
 assert.deepEqual(events.map(event=>event.action),['added','finished']);assert.equal((await history.get('1')).filename,'part.gcode');assert.equal((await history.totals()).total_jobs,1);
 assert.equal(runtime.status.pending,0);await runtime.close(stats);
}));
test('replaced jobs cancel the old record and close drains a pending start as server_exit',()=>fixture(async history=>{
 const runtime=new HistoryRuntime(history,{clock:()=>100});runtime.observe(change('started'));runtime.observe(change('started',{...stats,filename:'second.gcode'}));const closing=runtime.close({...stats,filename:'second.gcode'});
 runtime.observe(change('started',{...stats,filename:'ignored.gcode'}));await closing;
 const jobs=(await history.list({order:'asc'})).jobs;assert.deepEqual(jobs.map(job=>job.status),['cancelled','server_exit']);assert.equal(runtime.status.closed,true);assert.equal((await history.totals()).total_jobs,2);
}));
test('queued API mutations cannot pass a pending start and request errors do not stop tracking',()=>fixture(async history=>{
 const runtime=new HistoryRuntime(history);runtime.observe(change('started'));
 await assert.rejects(runtime.mutate(()=>history.resetTotals()),/invariant/);assert.equal(runtime.status.failure,null);
 runtime.observe(change('complete'));await runtime.drain();assert.equal((await runtime.mutate(()=>history.resetTotals())).last_totals.total_jobs,1);await runtime.close(stats);
}));
test('queue overflow is visible, bounded and prevents replay after an uncertain event gap',()=>fixture(async history=>{
 let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>release=r);
 const runtime=new HistoryRuntime(history,{maxPending:1,notify:async()=>{entered();await blocked;}});
 runtime.observe(change('started'));await ready;runtime.observe(change('complete'));assert.match(runtime.status.failure!,/capacity/);assert.equal(runtime.status.pending,1);release();
 await assert.rejects(runtime.drain(),/capacity/);runtime.observe(change('started'));assert.equal((await history.list()).count,1);assert.equal((await history.get('1')).status,'in_progress');await assert.rejects(runtime.close(stats),/capacity/);
}));
test('notification failures do not roll back durable history or poison subsequent persistence',()=>fixture(async history=>{
 const runtime=new HistoryRuntime(history,{notify:()=>{throw new Error('Notification offline');}});runtime.observe(change('started'));runtime.observe(change('complete'));await runtime.drain();
 assert.equal(runtime.status.failure,null);assert.equal(runtime.status.notificationError,'Notification offline');assert.equal((await history.get('1')).status,'completed');await runtime.close(stats);
}));
test('database failure fences the runtime and close reports it without replay',()=>fixture(async(history,db)=>{
 const runtime=new HistoryRuntime(history);runtime.observe(change('started'));await runtime.drain();await db.close();runtime.end('klippy_disconnect',stats);await assert.rejects(runtime.drain(),/closed/);await assert.rejects(runtime.close(stats),/closed/);assert.equal(runtime.status.closed,true);
}));
test('history event mapping and record snapshots match pinned upstream state handlers',()=>fixture(async history=>{
 const events:HistoryEvent[]=[],runtime=new HistoryRuntime(history,{clock:()=>100,notify:event=>{events.push(event);}});
 const {historyEventsOracle}=await import('./helpers/history-oracle.ts'),{execFileSync}=await import('node:child_process');
 const changes:JobChange[]=[
  change('started'),
  {kind:'state',event:'paused',previous:stats,current:stats},
  {kind:'state',event:'resumed',previous:stats,current:stats},
  change('complete'),
  change('started'),
  change('started',{...stats,filename:'second.gcode'}),
  {kind:'state',event:'standby',previous:{...stats,filename:'second.gcode'},current:{filename:'',total_duration:0}},
 ];
 const reference=JSON.parse(execFileSync('/usr/bin/python3',['-c',historyEventsOracle()],{input:JSON.stringify(changes),encoding:'utf8'}));
 for(const event of changes)runtime.observe(event);await runtime.drain();assert.deepEqual(events,reference);await runtime.close(stats);
}));
test('cancelled queued mutations do not execute or fault event tracking',()=>fixture(async history=>{
 let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r),abort=new AbortController();
 const runtime=new HistoryRuntime(history,{notify:async event=>{if(event.action==='added'){entered();await wait;}}});
 runtime.observe(change('started'));await ready;let executed=false;
 const mutation=runtime.mutate(async()=>{abort.signal.throwIfAborted();executed=true;return history.resetTotals();}),rejected=assert.rejects(mutation);
 abort.abort();release();await rejected;assert.equal(executed,false);assert.equal(runtime.status.failure,null);
 runtime.end('klippy_shutdown',stats);runtime.end('klippy_disconnect',stats);await runtime.drain();assert.equal((await history.get('1')).status,'klippy_shutdown');assert.equal((await history.totals()).total_jobs,1);await runtime.close(stats);
}));
test('event byte admission rejects oversized snapshots before queueing a write',()=>fixture(async history=>{
 const runtime=new HistoryRuntime(history,{maxPendingBytes:1});runtime.observe(change('started'));await assert.rejects(runtime.drain(),/capacity/);assert.equal(runtime.status.pendingBytes,0);assert.equal((await history.list()).count,0);await assert.rejects(runtime.close(stats),/capacity/);
}));
