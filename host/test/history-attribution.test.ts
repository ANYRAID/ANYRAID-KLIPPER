import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {getEventListeners} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HistoryAttribution} from '../src/moonraker/history-attribution.ts';
import {HistoryRuntime} from '../src/moonraker/history-runtime.ts';
import {HistoryRepository} from '../src/moonraker/history-repository.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {PrintApi} from '../src/moonraker/print-api.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {ApiError,type Json,type RpcContext} from '../src/moonraker/rpc.ts';
const signals=()=>({request:new AbortController(),lifetime:new AbortController()});
test('only one matching next start can consume a copied requester identity',()=>{
 const owner=new HistoryAttribution(),s=signals(),user={username:'alice'},settle=owner.begin('part',user,s.request.signal,s.lifetime.signal);user.username='bob';
 assert.throws(()=>owner.begin('part',user,s.request.signal,s.lifetime.signal),e=>e instanceof ApiError&&e.status===409);
 assert.equal(owner.claim('part'),'alice');settle(false);assert.equal(owner.claim('part'),undefined);assert.equal(owner.pending,false);
 assert.equal(getEventListeners(s.request.signal,'abort').length,0);assert.equal(getEventListeners(s.lifetime.signal,'abort').length,0);
 owner.begin('part',undefined,s.request.signal,s.lifetime.signal);assert.equal(owner.claim('other'),undefined);assert.equal(owner.claim('part'),undefined);
});
test('confirmed starts survive request completion but not connection death or an unrelated next start',()=>{
 const owner=new HistoryAttribution(),s=signals(),settle=owner.begin('part',{username:'alice'},s.request.signal,s.lifetime.signal);settle(true);s.request.abort();assert.equal(owner.claim('part'),'alice');
 const next=signals();owner.begin('part',{username:'bob'},next.request.signal,next.lifetime.signal)(true);next.lifetime.abort();assert.equal(owner.claim('part'),undefined);
 const last=signals();owner.begin('part',{username:'carol'},last.request.signal,last.lifetime.signal)(true);owner.claim('other');assert.equal(owner.claim('part'),undefined);
});
test('failure, cancellation, expiry and explicit reset cannot contaminate a future same-name job',async()=>{
 const owner=new HistoryAttribution({pendingMs:10,confirmedMs:10});
 for(const mode of ['failed','cancelled','expired','confirmedExpired','clear'] as const){const s=signals(),settle=owner.begin('part',{username:'alice'},s.request.signal,s.lifetime.signal);if(mode==='failed')settle(false);if(mode==='cancelled')s.request.abort();if(mode==='confirmedExpired')settle(true);if(mode==='clear')owner.clear();if(mode==='expired'||mode==='confirmedExpired')await delay(20);settle(true);assert.equal(owner.pending,false);assert.equal(owner.claim('part'),undefined);assert.equal(getEventListeners(s.lifetime.signal,'abort').length,0);}
});
async function fixture(run:(history:HistoryRepository)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'history-attribution-')),db=await DatabaseStore.open({path:join(dir,'db')});try{await run(await HistoryRepository.open(db));}finally{await db.close();await rm(dir,{recursive:true,force:true});}}
const stats={filename:'part',total_duration:1,print_duration:1,filament_used:1};
function start(runtime:HistoryRuntime,filename='part'){runtime.observe({kind:'state',event:'started',current:{...stats,filename},previous:stats});}
function complete(runtime:HistoryRuntime){runtime.observe({kind:'state',event:'complete',current:stats,previous:stats});}
test('history persists requester at observed start for both response orderings and never rewrites a later same-name job',()=>fixture(async history=>{
 const runtime=new HistoryRuntime(history);const a=signals(),settleA=runtime.beginPrint('part',{username:'alice'},a.request.signal,a.lifetime.signal);
 start(runtime);complete(runtime);settleA(false); // Observed start is evidence, even if the command later fails.
 const b=signals();runtime.beginPrint('part',{username:'bob'},b.request.signal,b.lifetime.signal)(true);b.request.abort();start(runtime);complete(runtime);
 start(runtime);complete(runtime);await runtime.drain();
 assert.deepEqual((await history.list({order:'asc'})).jobs.map(j=>j.user),['alice','bob','No User']);assert.equal((await history.totals()).total_jobs,3);await runtime.close(stats);
}));
test('shutdown, close and failed persistence revoke attribution and reject future tracked starts',()=>fixture(async history=>{
 const runtime=new HistoryRuntime(history),a=signals();runtime.beginPrint('part',{username:'alice'},a.request.signal,a.lifetime.signal)(true);runtime.end('klippy_disconnect',{});start(runtime);complete(runtime);await runtime.drain();assert.equal((await history.get('1')).user,'No User');
 runtime.beginPrint('part',{username:'bob'},a.request.signal,a.lifetime.signal)(true);await runtime.close(stats);assert.equal(runtime.status.awaitingPrintStart,false);assert.throws(()=>runtime.beginPrint('part',undefined,a.request.signal,a.lifetime.signal),/unavailable/);
 const failed=new HistoryRuntime(history,{maxPendingBytes:1});start(failed);await assert.rejects(failed.drain());assert.throws(()=>failed.beginPrint('part',undefined,a.request.signal,a.lifetime.signal),/unavailable/);await assert.rejects(failed.close(stats));
}));
test('PrintApi owns reservation before sending and clears it on backend failure independently of observers',()=>fixture(async history=>{
 const runtime=new HistoryRuntime(history),generation=new AbortController(),gate=new MaintenanceGate();let fail=false,calls=0;
 const api=new PrintApi({maintenanceGate:gate,backend:()=>({signal:generation.signal,snapshot:{connected:true,initialized:true,state:'ready',endpoints:['gcode/script']},async request(){calls++;if(fail)throw new ApiError(400,'Rejected');return 'ok';}}),beginStart:(event,request,lifetime)=>runtime.beginPrint(event.filename,event.user,request,lifetime),onStartComplete(){throw new Error('observer');}});
 const request=new AbortController(),ctx:RpcContext={transport:'http',signal:request.signal,authorize(){},user:{username:'alice'}};
 await api.call('start',{filename:'part'},ctx);request.abort();assert.equal(runtime.status.awaitingPrintStart,true);
 const next={...ctx,signal:new AbortController().signal};await assert.rejects(api.call('start',{filename:'part'},next),e=>e instanceof ApiError&&e.status===409);assert.equal(calls,1);
 start(runtime);complete(runtime);await runtime.drain();assert.equal((await history.get('1')).user,'alice');
 fail=true;await assert.rejects(api.call('start',{filename:'part'},next),/Rejected/);assert.equal(runtime.status.awaitingPrintStart,false);start(runtime);complete(runtime);await runtime.drain();assert.equal((await history.get('2')).user,'No User');assert.equal(gate.status.activities,0);api.close();await runtime.close(stats);
}));
test('late completions cannot clear a replacement claim, and shared signals retain lifetime cancellation',()=>{
 const owner=new HistoryAttribution(),s=signals(),old=owner.begin('part',{username:'alice'},s.request.signal,s.lifetime.signal);owner.clear();
 const current=owner.begin('part',{username:'bob'},s.request.signal,s.lifetime.signal);old(true);old(false);assert.equal(owner.claim('part'),'bob');current(true);
 const shared=new AbortController();owner.begin('part',{username:'carol'},shared.signal,shared.signal)(true);shared.abort();assert.equal(owner.claim('part'),undefined);assert.equal(owner.pending,false);
});
