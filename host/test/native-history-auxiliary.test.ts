import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {PrintJournal,JournalError} from '../src/operations/print-journal.ts';
import type {JournalHistoryEvent} from '../src/operations/print-journal-types.ts';
import type {HistoryAuxiliarySnapshot} from '../src/moonraker/history-repository.ts';
import {registerNativeHistory} from '../src/moonraker/native-history.ts';
import {JsonRpcDispatcher,ApiError} from '../src/moonraker/rpc.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
import type {NativePrintUploads} from '../src/moonraker/native-print-uploads.ts';
import {historyReference,historyReferenceInput} from './helpers/history-reference.ts';
import {verifyJournalRows} from '../bench/helpers/journal-rows.ts';
const request={version:1 as const,requestId:'job',fileId:'file',nozzle:0,bed:0},statistics={totalDuration:2,printDuration:1,filamentUsed:2.675};
const snapshot=(value=2.675):HistoryAuxiliarySnapshot=>({data:[{provider:'sensor room',name:'energy',value,negativeZero:-0}],totals:[{provider:'sensor room',field:'energy',value,report_total:true,report_maximum:true,precision:2}]});
async function fixture(run:(options:{path:string;deviceId:string},journal:PrintJournal)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'journal-auxiliary-')),options={path:join(root,'jobs.db'),deviceId:'printer'},journal=await PrintJournal.open(options);try{await run(options,journal);}finally{await journal.close();await rm(root,{recursive:true,force:true});}}
const code=(expected:string)=>(error:unknown)=>error instanceof JournalError&&error.code===expected;
test('daily journal benchmark verifies actual closed rows with read-only Node SQL and rejects changed payloads',()=>fixture(async(options,journal)=>{
 await journal.reserve({...request,requestId:'job0'});await journal.transition('job0',1,'started');await journal.transition('job0',2,'completed');await journal.close();verifyJournalRows(options.path,1,0,0);assert.throws(()=>verifyJournalRows(options.path,2,0,0));assert.throws(()=>verifyJournalRows(options.path,1,210,0));
 const db=new DatabaseSync(options.path);db.prepare('UPDATE requests SET request=?').run(JSON.stringify({...request,requestId:'job0',fileId:'other'}));db.close();assert.throws(()=>verifyJournalRows(options.path,1,0,0));
}));
test('native auxiliary totals match the original 35 pinned upstream binary64 inputs and reporting changes',()=>fixture(async(_options,journal)=>{
 const input=JSON.parse(historyReferenceInput('history-auxiliary-totals')) as Array<{value:number}>,steps=Array.from({length:35},(_,i)=>({provider:'sensor',field:'energy',value:input[i].value,report_total:i%4!==0,report_maximum:i%4!==1,precision:[2,-2,0,6,null][i%5]})),expected=historyReference<unknown[]>('history-auxiliary-totals',JSON.stringify(steps));
 for(const [i,step] of steps.entries()){const id='reference'+i;await journal.reserve({...request,requestId:id});await journal.transition(id,1,'cancelled',statistics,{data:[],totals:[step]});assert.deepEqual((await journal.historyTotals()).auxiliary_totals,expected[i]);}
}));
test('native auxiliary snapshots freeze at ingress and commit once with outcome, statistics, totals and notifications',()=>fixture(async(options,journal)=>{
 const events:JournalHistoryEvent[]=[];journal.subscribeHistory(e=>events.push(e));const initial=snapshot(0),reserved=journal.reserve(request,initial);initial.data[0]='mutated';await reserved;
 assert.equal(((await journal.get('job',true))!.auxiliary!.data[0] as {value:number}).value,0);await journal.transition('job',1,'started');const final=snapshot(),finishing=journal.transition('job',2,'failed',statistics,final);final.totals[0].value=100;final.data[0]='mutated';const completed=await finishing;
 assert.deepEqual(completed.statistics,statistics);assert.equal((completed.auxiliary!.data[0] as {value:number}).value,2.675);assert(Object.is((completed.auxiliary!.data[0] as {negativeZero:number}).negativeZero,-0));assert.equal((await journal.get('job'))!.auxiliary,undefined);assert.equal((await journal.scan()).records[0].auxiliary,undefined);assert.deepEqual((await journal.historyGet('1'))!.auxiliary,completed.auxiliary);
 assert.deepEqual((await journal.historyTotals()).auxiliary_totals,[{provider:'sensor room',field:'energy',maximum:2.67,total:2.67}]);assert.deepEqual(events.map(e=>e.action),['added','finished']);assert.deepEqual(events[1].record.auxiliary,completed.auxiliary);
 events[1].record.auxiliary!.data[0]='observer mutation';assert.deepEqual((await journal.get('job',true))!.auxiliary,completed.auxiliary);
 await journal.transition('job',3,'cancelled',undefined,snapshot(999));assert.deepEqual((await journal.get('job',true))!.auxiliary,completed.auxiliary);assert.equal((await journal.historyTotals()).job_totals.total_jobs,1);assert.equal(events.length,2);
 await journal.historyDelete('1');await journal.close();const reopened=await PrintJournal.open(options);try{assert.deepEqual((await reopened.get('job',true))!.auxiliary,completed.auxiliary);assert.equal(await reopened.historyGet('1'),null);assert.equal((await reopened.reserve(request,snapshot(999))).created,false);assert.equal((await reopened.historyTotals()).auxiliary_totals[0].total,2.67);}finally{await reopened.close();}
}));
test('native auxiliary overflow rolls back all fields, state, statistics and count, then admits a valid retry',()=>fixture(async(_options,journal)=>{
 await journal.reserve(request);await journal.transition('job',1,'cancelled',statistics,snapshot(1e308));await journal.reserve({...request,requestId:'second'});const bad=snapshot(1e308);bad.totals.unshift({...bad.totals[0],field:'first',value:1});
 const before=await journal.historyTotals();await assert.rejects(journal.transition('second',1,'failed',statistics,bad),code('INVALID'));assert.deepEqual(await journal.historyTotals(),before);assert.equal((await journal.get('second',true))!.state,'reserved');assert.equal((await journal.get('second',true))!.statistics,undefined);assert.equal((await journal.get('second',true))!.auxiliary,undefined);
 await journal.transition('second',1,'cancelled',statistics,snapshot(-1e308));assert.equal((await journal.historyTotals()).auxiliary_totals[0].total,0);assert.equal((await journal.historyTotals()).job_totals.total_jobs,2);
}));
test('reset uses declared provider fields, preserves unrelated totals, and never changes outcome snapshots',()=>fixture(async(_options,journal)=>{
 const source=snapshot(-2.675);source.totals.push({...source.totals[0],provider:'other',value:5,report_maximum:false});await journal.reserve(request);await assert.rejects(journal.historyResetTotals(source.totals),code('STATE'));await journal.transition('job',1,'cancelled',statistics,source);
 const before=await journal.historyTotals();assert.equal(before.auxiliary_totals[0].maximum,-2.67);const reset=await journal.historyResetTotals([source.totals[0]]);assert.deepEqual(reset.last_auxiliary_totals,before.auxiliary_totals);assert.deepEqual((await journal.historyTotals()).auxiliary_totals,[{provider:'sensor room',field:'energy',maximum:0,total:0},{provider:'other',field:'energy',maximum:null,total:5}]);assert.deepEqual((await journal.get('job',true))!.auxiliary?.data,source.data);
}));
test('native auxiliary validation rejects duplicates, nonfinite, oversized and cyclic snapshots before reservation',()=>fixture(async(_options,journal)=>{
 const duplicate=snapshot();duplicate.totals.push({...duplicate.totals[0]});const cycle=snapshot();cycle.data.push(cycle.data);
 for(const value of [duplicate,cycle,snapshot(NaN),{data:[],totals:[...Array(65)].map((_,i)=>({...snapshot().totals[0],field:String(i)}))},{data:['x'.repeat(1024*1024)],totals:[]}])await assert.rejects(journal.reserve(request,value));assert.equal(await journal.get('job',true),null);
 await journal.reserve(request);await assert.rejects(journal.transition('job',1,'started',undefined,snapshot()),/terminal outcome/);await assert.rejects(journal.transition('job',2,'cancelled',statistics,snapshot()),code('STALE'));assert.equal((await journal.get('job',true))!.revision,1);assert.equal((await journal.historyTotals()).job_totals.total_jobs,0);
}));
test('version five migration preserves replay and totals, rejects wrong identity atomically and invents no auxiliary values',()=>fixture(async(options,journal)=>{
 await journal.reserve(request);await journal.transition('job',1,'cancelled',statistics);const prior=await journal.get('job',true),totals=await journal.historyTotals();await journal.close();let db=new DatabaseSync(options.path);db.exec('DROP TABLE request_auxiliary; DROP TABLE history_auxiliary_totals; PRAGMA user_version=5;');db.close();const bytes=await readFile(options.path);
 await assert.rejects(PrintJournal.open({...options,deviceId:'wrong'}),code('DEVICE'));assert.deepEqual(await readFile(options.path),bytes);const migrated=await PrintJournal.open(options);try{assert.deepEqual(await migrated.get('job',true),prior);assert.deepEqual(await migrated.historyTotals(),totals);assert.equal((await migrated.reserve(request)).created,false);}finally{await migrated.close();}db=new DatabaseSync(options.path);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,6);db.close();
}));
test('interrupted reservation retains initial snapshot and cannot attach later telemetry during acknowledgement',()=>fixture(async(options,journal)=>{
 await journal.reserve(request,snapshot(0));await journal.transition('job',1,'started');await journal.close();const reopened=await PrintJournal.open(options);try{const active=(await reopened.active())!;assert.equal(active.state,'interrupted');await reopened.transition('job',active.revision,'cancelled',undefined,snapshot(999));assert.equal(((await reopened.get('job',true))!.auxiliary!.data[0] as {value:number}).value,0);assert.equal((await reopened.historyTotals()).auxiliary_totals[0].total,0);}finally{await reopened.close();}
}));
test('invalid persisted native auxiliary values fail closed without erasing a prior request',()=>fixture(async(options,journal)=>{
 await journal.reserve(request);await journal.transition('job',1,'cancelled',statistics,snapshot());await journal.close();let db=new DatabaseSync(options.path);db.prepare('UPDATE request_auxiliary SET snapshot=?').run(Buffer.from('not-json'));db.close();const reopened=await PrintJournal.open(options);try{await assert.rejects(reopened.get('job',true),code('CORRUPT'));await assert.rejects(reopened.reserve({...request,requestId:'next'}),code('CLOSED'));}finally{await reopened.close();}
 db=new DatabaseSync(options.path);db.prepare('UPDATE history_auxiliary_totals SET total=?').run(Infinity);db.close();await assert.rejects(PrintJournal.open(options),code('CORRUPT'));
}));
test('authenticated native history HTTP and RPC expose durable auxiliary data and totals',()=>fixture(async(_options,journal)=>{
 await journal.reserve(request);await journal.transition('job',1,'cancelled',statistics,snapshot());const rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc),files={async info(){return {};},filename(){return 'part.gcode';}} as unknown as NativePrintUploads,release=registerNativeHistory(registry,journal,files),network=new MoonrakerNetwork(rpc,{endpoints:registry,authorize(_m,_p,context){if(context.request.headers['x-api-key']!=='fixture')throw new ApiError(401,'Denied');}});
 try{const {port}=await network.listen(),base=`http://127.0.0.1:${port}`,headers={'x-api-key':'fixture'};assert.equal((await fetch(base+'/server/history/list')).status,401);const response=await fetch(base+'/server/history/job?uid=1',{headers}),body=await response.json() as any;assert.equal(response.status,200);assert.equal(body.result.job.auxiliary_data[0].value,2.675);
 const totals=await fetch(base+'/server/jsonrpc',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'server.history.totals',params:{}})});assert.equal(((await totals.json()) as any).result.auxiliary_totals[0].total,2.67);
 }finally{release();await network.close();}
}));
