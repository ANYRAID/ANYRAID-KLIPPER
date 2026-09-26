import test from 'node:test';
import assert from 'node:assert/strict';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
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
