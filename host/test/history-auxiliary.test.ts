import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {HistoryRepository,type HistoryAuxiliarySnapshot} from '../src/moonraker/history-repository.ts';
import {roundHistoryDecimal} from '../src/moonraker/history-round.ts';
import {registerHistory} from '../src/moonraker/history-api.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
const stats={filename:'part.gcode',start_time:100,total_duration:30,print_duration:25,filament_used:2.675};
const auxiliary=(value:number,precision:number|null=2):HistoryAuxiliarySnapshot=>({data:[{provider:'sensor',name:'energy',value}],totals:[{provider:'sensor',field:'energy',value,report_total:true,report_maximum:true,precision}]});
async function fixture(run:(history:HistoryRepository,db:DatabaseStore,path:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'history-aux-')),path=join(dir,'db'),db=await DatabaseStore.open({path});try{await run(await HistoryRepository.open(db),db,path);}finally{await db.close();await rm(dir,{recursive:true,force:true});}}
test('history decimal rounding matches CPython across ties, subnormals, signed zero and overflow',()=>{
 const values=[0,-0,2.675,-2.675,0.125,0.375,250,-350,Number.MIN_VALUE,-Number.MIN_VALUE,Number.MAX_VALUE,1e308];
 let seed=7349;const view=new DataView(new ArrayBuffer(8));for(let i=0;i<100;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;view.setUint32(0,seed);seed=(Math.imul(seed,1664525)+1013904223)>>>0;view.setUint32(4,seed);const value=view.getFloat64(0);if(Number.isFinite(value))values.push(value);}
 const cases=values.flatMap(value=>[-1000,-309,-308,-20,-2,0,2,6,20,308,323,324,1000].map(precision=>[String(value),precision] as const));
 cases.push(['-0',2]);
 const child=spawnSync('python3',['-c',`import sys,json,math
out=[]
for v,p in json.load(sys.stdin):
 try:
  result=round(float(v),p);out.append([result,math.copysign(1,result)<0])
 except OverflowError:out.append('overflow')
print(json.dumps(out))`],{input:JSON.stringify(cases),encoding:'utf8'});assert.equal(child.status,0,child.stderr);
 const expected=JSON.parse(child.stdout);cases.forEach(([value,precision],i)=>{if(expected[i]==='overflow')assert.throws(()=>roundHistoryDecimal(Number(value),precision));else{const result=roundHistoryDecimal(Number(value),precision);assert.equal(result,expected[i][0],`${value}, ${precision}`);assert.equal(result<0||Object.is(result,-0),expected[i][1]);}});
 assert.throws(()=>roundHistoryDecimal(NaN,2));assert.throws(()=>roundHistoryDecimal(1,Infinity));
});
test('auxiliary finish snapshots and totals commit exactly once and survive reopen',()=>fixture(async(history,db,path)=>{
 const first=await history.start({...stats,auxiliary_data:[{value:0}]}),snapshot=auxiliary(2.675);
 const [a,b]=await Promise.all([history.finish(first.job_id,'completed',stats,130,undefined,snapshot),history.finish(first.job_id,'completed',stats,130,undefined,snapshot)]);
 assert.deepEqual(a,b);assert.deepEqual(a.auxiliary_data,snapshot.data);
 assert.deepEqual((await history.allTotals()).auxiliary_totals,[{provider:'sensor',field:'energy',maximum:2.67,total:2.67}]);
 const second=await history.start(stats);await history.finish(second.job_id,'completed',stats,160,undefined,auxiliary(.005));
 // Add raw .005 to previously rounded 2.67, then round once. Pre-rounding the
 // increment would produce 2.68 and is incompatible with upstream.
 assert.equal((await history.allTotals()).auxiliary_totals[0].total,2.67);
 await db.close();const reopened=await DatabaseStore.open({path});try{const restored=await HistoryRepository.open(reopened);assert.deepEqual((await restored.get(first.job_id)).auxiliary_data,snapshot.data);assert.equal((await restored.allTotals()).auxiliary_totals[0].total,2.67);}finally{await reopened.close();}
}));
test('concurrent different jobs never lose auxiliary increments and reset returns previous totals',()=>fixture(async history=>{
 const jobs=await Promise.all(Array.from({length:12},()=>history.start(stats)));
 await Promise.all(jobs.map(job=>history.finish(job.job_id,'completed',stats,130,undefined,auxiliary(.125,3))));
 const before=await history.allTotals();assert.equal(before.job_totals.total_jobs,12);assert.equal(before.auxiliary_totals[0].total,1.5);
 const reset=await history.resetTotals(auxiliary(0).totals);assert.deepEqual(reset.last_auxiliary_totals,before.auxiliary_totals);assert.deepEqual(reset.last_totals,before.job_totals);
 assert.deepEqual((await history.allTotals()).auxiliary_totals,[{provider:'sensor',field:'energy',maximum:0,total:0}]);
}));
test('negative maxima, reporting flag changes and no-precision totals follow field semantics',()=>fixture(async history=>{
 for(const value of [-5,-8,-2]){const job=await history.start(stats);await history.finish(job.job_id,'completed',stats,130,undefined,auxiliary(value,null));}
 assert.deepEqual((await history.allTotals()).auxiliary_totals,[{provider:'sensor',field:'energy',maximum:-2,total:-15}]);
 const job=await history.start(stats),snapshot=auxiliary(2.675);snapshot.totals[0].report_maximum=false;
 await history.finish(job.job_id,'completed',stats,130,undefined,snapshot);assert.deepEqual((await history.allTotals()).auxiliary_totals,[{provider:'sensor',field:'energy',maximum:null,total:-12.32}]);
 await history.resetTotals(snapshot.totals);assert.equal((await history.allTotals()).auxiliary_totals[0].maximum,null);
}));
test('auxiliary overflow rolls back base totals, earlier auxiliary writes and completion',()=>fixture(async history=>{
 const first=await history.start(stats);await history.finish(first.job_id,'completed',stats,130,undefined,auxiliary(1e308,null));
 const next=await history.start(stats),snapshot=auxiliary(1e308,null);snapshot.totals.unshift({...snapshot.totals[0],field:'other',value:1});const before=await history.allTotals();
 await assert.rejects(history.finish(next.job_id,'completed',stats,130,undefined,snapshot),/total|finite|overflow/i);
 assert.deepEqual(await history.allTotals(),before);assert.equal((await history.get(next.job_id)).status,'in_progress');assert.deepEqual((await history.get(next.job_id)).auxiliary_data,[]);
}));
test('existing totals are added before rounding even when the isolated increment would overflow',()=>fixture(async history=>{
 const first=await history.start(stats),initial=auxiliary(-1e308,-308);initial.totals[0].report_maximum=false;
 await history.finish(first.job_id,'completed',stats,130,undefined,initial);
 const next=await history.start(stats),increment=auxiliary(1.7e308,-308);increment.totals[0].report_maximum=false;
 assert.throws(()=>roundHistoryDecimal(1.7e308,-308));
 await history.finish(next.job_id,'completed',stats,130,undefined,increment);
 assert.deepEqual((await history.allTotals()).auxiliary_totals,[{provider:'sensor',field:'energy',maximum:null,total:1e308}]);
}));
test('invalid auxiliary fields or corrupted stored totals cannot commit partial resets',()=>fixture(async(history,db)=>{
 const job=await history.start(stats),bad=auxiliary(1);bad.totals.push({...bad.totals[0]});await assert.rejects(history.finish(job.job_id,'completed',stats,130,undefined,bad),/Duplicate/);
 bad.totals=[{...bad.totals[0],provider:'history'}];await assert.rejects(history.finish(job.job_id,'completed',stats,130,undefined,bad),/Invalid/);
 await history.finish(job.job_id,'completed',stats,130,undefined,auxiliary(1));
 await db.sql(['job_totals'],[{sql:"UPDATE job_totals SET total='bad' WHERE provider='sensor'"}]);
 await assert.rejects(history.resetTotals(),/invariant/);assert.equal((await history.totals()).total_jobs,1);
}));
test('stored auxiliary totals match pinned HistoryFieldData over reporting and precision changes',()=>fixture(async history=>{
 const ref=JSON.parse(readFileSync(new URL('../contracts/moonraker-history-fields.json',import.meta.url),'utf8'));assert.equal(createHash('sha256').update(ref.source).digest('hex'),ref.sourceSha256);
 const steps=Array.from({length:35},(_,i)=>({provider:'sensor',field:'energy',value:Math.sin(i+1)*300,report_total:i%4!==0,report_maximum:i%4!==1,precision:[2,-2,0,6,null][i%5]}));
 const child=spawnSync('python3',['-c',`from __future__ import annotations
import ast,json,sys,types,sqlite3
from typing import *
tree=ast.parse(${JSON.stringify(ref.source)})
method=next(n for n in tree.body[0].body if isinstance(n,ast.FunctionDef) and n.name=='get_totals')
exec('from __future__ import annotations\\n'+ast.unparse(method))
last=[];out=[]
db=sqlite3.connect(':memory:');db.execute('CREATE TABLE totals(provider TEXT,field TEXT,maximum REAL,total REAL)')
for step in json.load(sys.stdin):
 owner=types.SimpleNamespace(_name=step['field'],_provider=step['provider'],_report_total=step['report_total'],_report_maximum=step['report_maximum'],_precision=step['precision'],has_totals=lambda:True,_tracker=types.SimpleNamespace(get_tracked_value=lambda:float(step['value'])))
 last=[get_totals(owner,last)]
 db.execute('DELETE FROM totals');db.execute('INSERT INTO totals VALUES(?,?,?,?)',list(last[0].values()))
 out.append([dict(zip(['provider','field','maximum','total'],db.execute('SELECT * FROM totals').fetchone()))])
print(json.dumps(out))`],{input:JSON.stringify(steps),encoding:'utf8'});assert.equal(child.status,0,child.stderr);const expected=JSON.parse(child.stdout);
 for(const [i,step] of steps.entries()){const job=await history.start(stats);await history.finish(job.job_id,'completed',stats,130,undefined,{data:[],totals:[step]});assert.deepEqual((await history.allTotals()).auxiliary_totals,expected[i]);}
}));
test('history API returns stored auxiliary totals and resets only registered fields',()=>fixture(async(history,db)=>{
 const job=await history.start(stats);await history.finish(job.job_id,'completed',stats,130,undefined,auxiliary(2.675));
 await db.sql(['job_totals'],[{sql:"INSERT INTO job_totals VALUES('absent','old',12,24,'default')"}]);
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),release=registerHistory(registry,{repository:history,fileExists:()=>false,auxiliaryTotals:()=>auxiliary(0).totals}),context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
 try{
  const before=await registry.invoke('/server/history/totals','GET',{},context) as any;assert.equal(before.auxiliary_totals[0].total,2.67);
  const reset=await registry.invoke('/server/history/reset_totals','POST',{},context) as any;assert.deepEqual(reset.last_auxiliary_totals,before.auxiliary_totals);
  const after=await registry.invoke('/server/history/totals','GET',{},context) as any;assert.equal(after.auxiliary_totals[0].total,0);assert.equal(after.auxiliary_totals[1].total,24);
 }finally{release();}
}));
