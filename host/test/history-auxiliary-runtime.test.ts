import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {HistoryRepository} from '../src/moonraker/history-repository.ts';
import {HistoryRuntime,type HistoryRuntimeOptions,type HistoryEvent} from '../src/moonraker/history-runtime.ts';
import {HistoryTracker} from '../src/moonraker/history-tracker.ts';
import type {JobEvent} from '../src/moonraker/job-state.ts';
const stats={filename:'part.gcode',total_duration:30,print_duration:25,filament_used:2.675};
const change=(event:JobEvent)=>({kind:'state' as const,event,current:stats,previous:stats});
async function fixture(run:(history:HistoryRepository)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'history-aux-runtime-')),db=await DatabaseStore.open({path:join(dir,'db')});try{await run(await HistoryRepository.open(db));}finally{await db.close();await rm(dir,{recursive:true,force:true});}}
function source(){
 let trackers:HistoryTracker[]=[];
 const factory:NonNullable<HistoryRuntimeOptions['auxiliary']>=trackingEnabled=>{
  trackers=['accumulate','delta'].map(strategy=>new HistoryTracker({strategy:strategy as 'accumulate'|'delta',trackingEnabled,excludePaused:true,reset:()=>0}));
  return {reset(){for(const tracker of trackers)tracker.reset();},snapshot(){return {data:trackers.map((tracker,i)=>({provider:'sensor',name:String(i),value:tracker.value})),totals:trackers.map((tracker,i)=>({provider:'sensor',field:String(i),value:tracker.value as number,report_total:true,report_maximum:true,precision:2}))};}};
 };
 return {factory,update(value:number){for(const tracker of trackers)tracker.update(value);},values(){return trackers.map(t=>t.value);}};
}
test('ingress gating and snapshots bind rapid starts, pauses and completions to their own job',()=>fixture(async history=>{
 const samples=source(),events:HistoryEvent[]=[],runtime=new HistoryRuntime(history,{auxiliary:samples.factory,notify:event=>{events.push(event);}});
 samples.update(100);runtime.observe(change('started'));samples.update(2);runtime.observe(change('paused'));samples.update(10);runtime.observe(change('resumed'));samples.update(15);runtime.observe(change('complete'));
 samples.update(999);runtime.observe(change('started'));samples.update(3);runtime.observe(change('complete'));samples.update(1000);await runtime.drain();
 assert.deepEqual(events.map(event=>event.job.auxiliary_data.map((field:any)=>field.value)),[[0,0],[17,7],[0,0],[3,3]]);
 assert.deepEqual((await history.allTotals()).auxiliary_totals.map(t=>t.total),[20,10]);await runtime.close(stats);
}));
test('replacement start captures old fields before reset and close captures before later samples',()=>fixture(async history=>{
 const samples=source(),runtime=new HistoryRuntime(history,{auxiliary:samples.factory});runtime.observe(change('started'));samples.update(4);runtime.observe(change('started'));samples.update(7);const closing=runtime.close(stats);samples.update(99);await closing;
 const jobs=(await history.list({order:'asc'})).jobs;assert.deepEqual(jobs.map(job=>job.status),['cancelled','server_exit']);assert.deepEqual(jobs.map(job=>job.auxiliary_data.map((field:any)=>field.value)),[[4,4],[7,7]]);
 assert.deepEqual((await history.allTotals()).auxiliary_totals.map(t=>t.total),[11,11]);
}));
test('blocked notification cannot move later samples into an earlier persisted job',()=>fixture(async history=>{
 let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r),samples=source();
 const runtime=new HistoryRuntime(history,{auxiliary:samples.factory,notify:async event=>{if(event.action==='added'&&event.job.job_id==='000001'){entered();await waiting;}}});
 runtime.observe(change('started'));await ready;samples.update(2);runtime.observe(change('complete'));runtime.observe(change('started'));samples.update(9);runtime.end('klippy_shutdown',stats);runtime.end('klippy_disconnect',stats);release();await runtime.drain();
 const jobs=(await history.list({order:'asc'})).jobs;assert.deepEqual(jobs.map(job=>job.status),['completed','klippy_shutdown']);assert.deepEqual(jobs.map(job=>job.auxiliary_data.map((field:any)=>field.value)),[[2,2],[9,9]]);await runtime.close(stats);
}));
test('auxiliary capacity and invalid fields fail before start persistence and fence sampling',()=>fixture(async history=>{
 for(const snapshot of [{data:['x'.repeat(300)],totals:[]},{data:[],totals:[{provider:'history',field:'invalid',value:1,report_total:true,report_maximum:false}]}]){
  let enabled!:(exclude:boolean)=>boolean;const runtime=new HistoryRuntime(history,{maxPendingBytes:200,auxiliary:gate=>{enabled=gate;return {reset(){},snapshot:()=>snapshot};}});
  runtime.observe(change('started'));await assert.rejects(runtime.drain());assert.equal(enabled(false),false);assert.equal((await history.list()).count,0);await assert.rejects(runtime.close(stats));
 }
}));
test('asynchronous auxiliary reset and snapshot are observed without unhandled rejections',()=>fixture(async history=>{
 for(const method of ['reset','snapshot'] as const){
  const runtime=new HistoryRuntime(history,{auxiliary:()=>({reset(){},snapshot:()=>({data:[],totals:[]}),[method]:async()=>{throw new Error('async failure');}}) as any});
  runtime.observe(change('started'));await assert.rejects(runtime.drain(),/synchronous/);assert.equal((await history.list()).count,0);await assert.rejects(runtime.close(stats),/synchronous/);
 }
}));
test('provider failure at finish retains interrupted evidence and disables subsequent samples',()=>fixture(async history=>{
 let failed=false,enabled!:(exclude:boolean)=>boolean;const runtime=new HistoryRuntime(history,{auxiliary:gate=>{enabled=gate;return {reset(){},snapshot(){if(failed)throw new Error('sensor unavailable');return {data:[],totals:[]};}};}});
 runtime.observe(change('started'));await runtime.drain();failed=true;runtime.observe(change('complete'));await assert.rejects(runtime.drain(),/sensor unavailable/);assert.equal(enabled(false),false);assert.equal((await history.get('1')).status,'in_progress');assert.equal((await history.totals()).total_jobs,0);await assert.rejects(runtime.close(stats));
}));
test('caller-owned auxiliary objects are copied before queued persistence',()=>fixture(async history=>{
 const frame={data:[{value:0}],totals:[{provider:'sensor',field:'energy',value:0,report_total:true,report_maximum:false}]};
 const runtime=new HistoryRuntime(history,{auxiliary:()=>({reset(){frame.data[0].value=0;frame.totals[0].value=0;},snapshot:()=>frame})});
 runtime.observe(change('started'));frame.data[0].value=5;frame.totals[0].value=5;runtime.observe(change('complete'));frame.data[0].value=99;frame.totals[0].value=99;await runtime.drain();
 assert.deepEqual((await history.get('1')).auxiliary_data,[{value:5}]);assert.equal((await history.allTotals()).auxiliary_totals[0].total,5);await runtime.close(stats);
 assert.throws(()=>new HistoryRuntime(history,{auxiliary:(async()=>{throw new Error('factory');}) as any}),/synchronous/);
}));
