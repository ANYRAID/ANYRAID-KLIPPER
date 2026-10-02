import test from 'node:test';
import assert from 'node:assert/strict';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
test('firmware and ordinary requests have separate receipts and coalesce only the same running kind',async()=>{
 const control=new ProductHostControl(),scope=new AbortController(),done=Promise.withResolvers<void>();let sent:((sent:boolean)=>void)|undefined,calls=0;
 control.attach(kind=>{assert.equal(kind,'firmware_restart');calls++;return done.promise;},()=>{},{kinds:['restart','firmware_restart'],generationSignal:scope.signal});
 const first=await control.requestFirmwareRestart(scope.signal,false,cb=>{sent=cb;});assert.equal(first.kind,'firmware_restart');assert.equal(control.status.restart_operation,null);await assert.rejects(control.requestFirmwareRestart(scope.signal,false,()=>assert.fail()),/pending/);sent!(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal((await control.requestFirmwareRestart(scope.signal,false,()=>assert.fail())).request_id,first.request_id);await assert.rejects(control.requestRestart(scope.signal,false,()=>assert.fail()),/pending/);scope.abort();await assert.rejects(control.requestFirmwareRestart(scope.signal,false,()=>assert.fail()),/retired/);done.resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal(control.status.firmware_restart_operation?.state,'succeeded');await control.close();
});
test('standard restart fences retired admissions, keeps one running receipt and rejects queued duplicates',async()=>{
 const control=new ProductHostControl(),scope=new AbortController(),done=Promise.withResolvers<void>();let calls=0,sent:((sent:boolean)=>void)|undefined;
 const detach=control.attach(kind=>{assert.equal(kind,'restart');calls++;return done.promise;},()=>{},{generationSignal:scope.signal});
 const record=await control.requestRestart(scope.signal,false,cb=>{sent=cb;});assert.equal(record.state,'queued');assert.equal(calls,0);
 await assert.rejects(control.requestRestart(scope.signal,false,()=>assert.fail()),/already pending/);assert.equal(control.status.restart_operation?.request_id,record.request_id);
 sent!(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal((await control.requestRestart(scope.signal,false,()=>assert.fail())).request_id,record.request_id);
 scope.abort();await assert.rejects(control.requestRestart(scope.signal,false,()=>assert.fail()),/retired/);detach();done.resolve();await new Promise(resolve=>setImmediate(resolve));
 control.attach(async kind=>{assert.equal(kind,'restart');calls++;},()=>{},{kinds:['restart'],generationSignal:scope.signal});assert.equal(control.status.available,false);assert.equal(control.status.restart_available,true);
 const retry=await control.requestRestart(scope.signal,true,cb=>cb(true));assert.notEqual(retry.request_id,record.request_id);await new Promise(resolve=>setImmediate(resolve));assert.equal(control.operation(retry.request_id)?.state,'succeeded');assert.equal(calls,2);await control.close();
});
test('rejected standard admission retains the preceding durable outcome',async()=>{
 const control=new ProductHostControl();let allowed=true;control.attach(async()=>{},()=>{if(!allowed)throw new Error('Active maintenance');});const accepted=await control.requestRestart(undefined,undefined,cb=>cb(true));await new Promise(resolve=>setImmediate(resolve));assert.equal(control.operation(accepted.request_id)?.state,'succeeded');allowed=false;await assert.rejects(control.requestRestart(undefined,undefined,()=>assert.fail()),/maintenance/);assert.equal(control.status.restart_operation?.request_id,accepted.request_id);assert.equal(control.status.restart_operation?.state,'succeeded');await control.close();
});
test('local reinitialization waits for owner completion and coalesces duplicate requests',async()=>{
 const control=new ProductHostControl();await assert.rejects(control.reinitialize(),/not ready/);
 const done=Promise.withResolvers<void>();let calls=0;const off=control.attach(()=>{calls++;return done.promise;});assert.throws(()=>control.attach(()=>Promise.resolve()),/already owned/);
 const first=control.reinitialize();assert.equal(first,control.reinitialize());assert.equal(calls,1);off();assert.equal(first,control.reinitialize());done.resolve();await first;await assert.rejects(control.reinitialize(),/not ready/);
 const remove=control.attach(()=>{throw new Error('busy');});await assert.rejects(control.reinitialize(),/busy/);remove();
});
test('remote recovery waits for response, retains receipt across generations and rejects stale or busy requests',async()=>{
 const control=new ProductHostControl(),done=Promise.withResolvers<void>();let calls=0,send:((sent:boolean)=>void)|undefined;
 const detach=control.attach(()=>{calls++;return done.promise;});const token=control.status.state_token;
 assert.equal((await control.request('one',token,callback=>{send=callback;})).state,'queued');assert.equal(calls,0);assert.equal((await control.request('one',token,()=>assert.fail())).state,'queued');await assert.rejects(control.request('two',token,()=>{}),/pending/);await assert.rejects(control.reinitialize(),/response is pending/);
 send!(true);send!(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal(control.operation('one')?.state,'running');detach();control.attach(async()=>{});done.resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal(control.operation('one')?.state,'succeeded');assert.equal((await control.request('one',token,()=>assert.fail())).state,'succeeded');await assert.rejects(control.request('two',token,()=>{}),/Stale/);await assert.rejects(control.request('one',control.status.state_token,()=>{}),/conflicts/);
});
test('failed response handoff or detached owner never dispatches recovery',async()=>{
 for(const cancel of [false,true]){const control=new ProductHostControl();let calls=0,send:((sent:boolean)=>void)|undefined;const detach=control.attach(async()=>{calls++;});await control.request('one',control.status.state_token,callback=>{send=callback;});if(cancel)detach();else send!(false);send!(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);assert.equal(control.operation('one')?.state,'failed');}
});
test('remote recovery rechecks readiness after response and records failure without invoking unavailable device',async()=>{
 const control=new ProductHostControl();let idle=true,calls=0,send:((sent:boolean)=>void)|undefined;const validate=()=>{if(!idle)throw new Error('busy');};control.attach(async()=>{validate();calls++;},validate);await control.request('one',control.status.state_token,callback=>{send=callback;});idle=false;send!(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);assert.equal(control.operation('one')?.state,'failed');await assert.rejects(control.request('two',control.status.state_token,()=>{}),/busy/);
});
