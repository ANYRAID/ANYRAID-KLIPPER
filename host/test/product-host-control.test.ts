import test from 'node:test';
import assert from 'node:assert/strict';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
test('local reinitialization waits for owner completion and coalesces duplicate requests',async()=>{
 const control=new ProductHostControl();await assert.rejects(control.reinitialize(),/not ready/);
 const done=Promise.withResolvers<void>();let calls=0;const off=control.attach(()=>{calls++;return done.promise;});assert.throws(()=>control.attach(()=>Promise.resolve()),/already owned/);
 const first=control.reinitialize();assert.equal(first,control.reinitialize());assert.equal(calls,1);off();assert.equal(first,control.reinitialize());done.resolve();await first;await assert.rejects(control.reinitialize(),/not ready/);
 const remove=control.attach(()=>{throw new Error('busy');});await assert.rejects(control.reinitialize(),/busy/);remove();
});
