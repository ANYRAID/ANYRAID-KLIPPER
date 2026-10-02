import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {HistoryRepository} from '../src/moonraker/history-repository.ts';
import {HistoryRuntime} from '../src/moonraker/history-runtime.ts';
import {captureHistoryMetadata,type HistoryMetadataSnapshot} from '../src/moonraker/history-metadata.ts';
import {historyMetadataOracle} from './helpers/history-oracle.ts';
import {encodeDatabaseRecord} from '../src/moonraker/database-record.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
const stats={filename:'part.gcode',total_duration:3,print_duration:2,filament_used:2.675};
async function fixture(run:(history:HistoryRepository)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'history-metadata-')),db=await DatabaseStore.open({path:join(dir,'db')});try{await run(await HistoryRepository.open(db));}finally{await db.close();await rm(dir,{recursive:true,force:true});}}
test('metadata cleanup matches pinned upstream and never mutates caller-owned fields',()=>{
 const fields={print_start_time:100,job_id:'prior',size:1e20,negativeZero:-0,modified:99,thumbnails:[{data:'aGVsbG8=',relative_path:'thumb.png',size:5}]},saved=structuredClone(fields);
 const actual=captureHistoryMetadata({generation:'mv-1',fields}).snapshot.fields,expected=JSON.parse(execFileSync('/usr/bin/python3',['-c',historyMetadataOracle()],{input:encodeDatabaseRecord(fields),encoding:'utf8'}));
 assert.deepEqual(actual,expected);assert.deepEqual(fields,saved);assert.equal(Object.hasOwn(actual,'job_id'),false);
});
test('queued metadata snapshots isolate source mutations and refresh only the bound generation',()=>fixture(async history=>{
 const source={generation:'mv-1',fields:{value:1,modified:99,print_start_time:4,job_id:'old'}},runtime=new HistoryRuntime(history,{metadata:()=>source});
 runtime.observe({kind:'state',event:'started',previous:{},current:stats});source.fields.value=2;await runtime.drain();assert.equal((await history.get('1')).metadata.value,1);
 source.fields.value=3;runtime.observe({kind:'state',event:'complete',previous:stats,current:stats});source.fields.value=4;await runtime.drain();assert.deepEqual((await history.get('1')).metadata,{value:3,modified:99});await runtime.close(stats);
}));
test('replacement versions and mismatched filenames cannot overwrite the initial job metadata',()=>fixture(async history=>{
 let snapshot:HistoryMetadataSnapshot={generation:'mv-1',fields:{source:'original'}};
 const runtime=new HistoryRuntime(history,{metadata:()=>snapshot});runtime.observe({kind:'state',event:'started',previous:{},current:stats});await runtime.drain();
 snapshot={generation:'mv-2',fields:{source:'replacement'}};runtime.observe({kind:'state',event:'complete',previous:stats,current:stats});await runtime.drain();assert.equal((await history.get('1')).metadata.source,'original');
 runtime.observe({kind:'state',event:'started',previous:stats,current:stats});await runtime.drain();snapshot={generation:'mv-2',fields:{source:'other filename'}};runtime.observe({kind:'state',event:'complete',previous:stats,current:{...stats,filename:'other.gcode'}});await runtime.drain();assert.equal((await history.get('2')).metadata.source,'replacement');await runtime.close(stats);
}));
test('missing start metadata stays unbound while metadata errors do not discard job statistics',()=>fixture(async history=>{
 let source:HistoryMetadataSnapshot|undefined,fault=false;const runtime=new HistoryRuntime(history,{metadata:()=>{if(fault)throw new Error('Metadata monitor unavailable');return source;}});
 runtime.observe({kind:'state',event:'started',previous:{},current:stats});await runtime.drain();source={generation:'mv-1',fields:{late:true}};runtime.observe({kind:'state',event:'complete',previous:stats,current:stats});await runtime.drain();assert.deepEqual((await history.get('1')).metadata,{});
 fault=true;runtime.observe({kind:'state',event:'started',previous:stats,current:stats});runtime.observe({kind:'state',event:'complete',previous:stats,current:stats});await runtime.drain();assert.equal(runtime.status.failure,null);assert.match(runtime.status.metadataError!,/unavailable/);assert.equal((await history.totals()).total_jobs,2);await runtime.close(stats);
}));
test('invalid metadata replacement cannot commit status or totals',()=>fixture(async history=>{
 const job=await history.start({...stats,start_time:100});
 await assert.rejects(history.finish(job.job_id,'completed',stats,110,[] as unknown as Record<string,never>),e=>e instanceof ApiError&&e.status===400);
 assert.equal((await history.get(job.job_id)).status,'in_progress');assert.equal((await history.totals()).total_jobs,0);
 assert.throws(()=>captureHistoryMetadata({generation:'mv-1',fields:{data:'x'.repeat(1024*1024)}}),e=>e instanceof ApiError&&e.status===413);
}));
test('discarded image payloads do not consume retained metadata budget',()=>{
 const source={generation:'mv-1',fields:{thumbnails:[{data:'x'.repeat(2*1024*1024),size:32}]}};
 const captured=captureHistoryMetadata(source);assert.deepEqual(captured.snapshot.fields,{thumbnails:[{size:32}]});assert.ok(captured.bytes<100);assert.equal(source.fields.thumbnails[0].data.length,2*1024*1024);
});
test('unsupported async metadata providers are observed without an unhandled rejection',()=>fixture(async history=>{
 const {type}= {type:'sync'};
 const runtime=new HistoryRuntime(history,{metadata:(async()=>{throw new Error(type);}) as unknown as ()=>HistoryMetadataSnapshot});
 runtime.observe({kind:'state',event:'started',previous:{},current:stats});await runtime.drain();assert.match(runtime.status.metadataError!,/synchronous/);assert.equal(runtime.status.failure,null);await runtime.close(stats);
}));
