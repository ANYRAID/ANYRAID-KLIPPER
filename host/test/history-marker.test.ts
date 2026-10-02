import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {HistoryRepository} from '../src/moonraker/history-repository.ts';
import {HistoryFileMetadata} from '../src/moonraker/history-file-metadata.ts';
import {ApiError,type Json} from '../src/moonraker/rpc.ts';
const input={filename:'part.gcode',start_time:100,total_duration:0,print_duration:0,filament_used:0,metadata:{size:1},metadata_generation:'mv-1'};
async function fixture(run:(history:HistoryRepository,db:DatabaseStore,path:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'history-marker-')),path=join(dir,'db'),db=await DatabaseStore.open({path});try{await run(await HistoryRepository.open(db),db,path);}finally{await db.close();await rm(dir,{recursive:true,force:true});}}
test('markers persist across restart, update only their selected generation and retain exact 64-bit IDs',()=>fixture(async(history,db,path)=>{
 await history.start(input);assert.deepEqual(await history.metadataMarker(input.filename,'mv-1'),{job_id:'000001',print_start_time:100});
 await db.sql(['job_history'],[{sql:'UPDATE job_history SET job_id=? WHERE job_id=1',params:[{integer:'9007199254740993'}]}]);
 const next=await history.start({...input,start_time:101,metadata_generation:'mv-2'});assert.equal(next.job_id,'20000000000002');assert.equal(await history.metadataMarker(input.filename,'mv-1'),undefined);assert.deepEqual(await history.metadataMarker(input.filename,'mv-2'),{job_id:next.job_id,print_start_time:101});
 await db.close();const reopened=await DatabaseStore.open({path});try{const again=await HistoryRepository.open(reopened);assert.equal((await again.metadataMarker(input.filename,'mv-2'))?.job_id,next.job_id);assert.equal((await again.get(next.job_id)).status,'interrupted');}finally{await reopened.close();}
}));
test('failed marker transaction rolls back both job creation and marker replacement',()=>fixture(async(history,db)=>{
 await history.start(input);const original=db.sql.bind(db);db.sql=(tables,operations)=>original(tables,[...operations,{sql:'SELECT 1',expectRows:0}]);
 await assert.rejects(history.start({...input,start_time:200,metadata_generation:'mv-2'}),e=>e instanceof ApiError&&e.status===409);db.sql=original;
 assert.equal((await history.list()).count,1);assert.deepEqual(await history.metadataMarker(input.filename,'mv-1'),{job_id:'000001',print_start_time:100});assert.equal(await history.metadataMarker(input.filename,'mv-2'),undefined);
}));
test('unbound jobs do not fabricate markers and invalid generation input cannot create jobs',()=>fixture(async(history)=>{
 await history.start({...input,metadata_generation:undefined});assert.equal(await history.metadataMarker(input.filename,'mv-1'),undefined);
 for(const metadata_generation of ['', 'x'.repeat(257),'\ud800'])await assert.rejects(history.start({...input,metadata_generation}),e=>e instanceof ApiError&&e.status===400);
 assert.equal((await history.list()).count,1);
}));
test('metadata overlay rechecks generation after the database read and never mutates a snapshot',async()=>{
 let generation='mv-1';const fields=Object.freeze({filename:'part.gcode',size:1,job_id:'stale',print_start_time:0}),pending=Promise.withResolvers<{job_id:string;print_start_time:number}|undefined>();
 const source={historyMetadata:()=>({generation,fields}),metadata:()=>fields,thumbnails:()=>[]};
 const view=new HistoryFileMetadata(source,{metadataMarker:()=>pending.promise});const reading=view.metadata(input.filename);generation='mv-2';pending.resolve({job_id:'000001',print_start_time:100});await assert.rejects(reading,e=>e instanceof ApiError&&e.status===409);assert.equal(fields.job_id,'stale');
 const good=new HistoryFileMetadata(source,{metadataMarker:async()=>({job_id:'000002',print_start_time:101})});assert.deepEqual(await good.metadata(input.filename),{filename:'part.gcode',size:1,job_id:'000002',print_start_time:101});
 const absent=new HistoryFileMetadata(source,{metadataMarker:async()=>undefined});assert.deepEqual(await absent.metadata(input.filename),{filename:'part.gcode',size:1});assert.deepEqual(absent.thumbnails(input.filename),[]);
});
test('deleted history does not erase last-print metadata and corrupt markers fail explicitly',()=>fixture(async(history,db)=>{
 const job=await history.start(input);await history.finish(job.job_id,'completed',input,101);await history.delete(job.job_id);assert.equal((await history.metadataMarker(input.filename,'mv-1'))?.job_id,job.job_id);
 await db.sql(['history_metadata'],[{sql:'UPDATE history_metadata SET job_id=0'}]);await assert.rejects(history.metadataMarker(input.filename,'mv-1'),e=>e instanceof ApiError&&e.status===422);
}));
test('exposed print marker fields match pinned upstream metadata writeback',()=>fixture(async(history)=>{
 const {execFileSync}=await import('node:child_process'),{historyMarkerOracle}=await import('./helpers/history-oracle.ts');
 const job=await history.start(input),reference=JSON.parse(execFileSync('/usr/bin/python3',['-c',historyMarkerOracle()],{input:JSON.stringify({...input,job_id:job.job_id}),encoding:'utf8'}));
 assert.deepEqual({...input.metadata,...await history.metadataMarker(input.filename,'mv-1')},reference);
}));
