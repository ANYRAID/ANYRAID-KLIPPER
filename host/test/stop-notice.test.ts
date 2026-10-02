import test from 'node:test';
import assert from 'node:assert/strict';
import {StopNotice} from '../src/runtime/stop-notice.ts';
test('stop notification is one-shot, bounded and detachable with original-cause replay',()=>{
 const n=new StopNotice(),cause=new Error('first'),seen:unknown[]=[];const listener=(v:unknown)=>{seen.push(v);},off=n.subscribe(listener);assert.throws(()=>n.subscribe(listener),/subscription/);off();off();n.emit(cause);n.emit(new Error('later'));n.subscribe(listener);assert.deepEqual(seen,[cause]);
 const full=new StopNotice();for(let i=0;i<64;i++)full.subscribe(()=>{});assert.throws(()=>full.subscribe(()=>{}),/subscription/);
});
test('throwing or rejected observers cannot prevent peer invalidation or create unhandled work',async()=>{
 const n=new StopNotice(),sync=new Error('sync'),asyncError=new Error('async');let calls=0;n.subscribe(()=>{throw sync;});n.subscribe(async()=>{throw asyncError;});n.subscribe(()=>{calls++;n.emit(new Error('recursive'));});n.emit(new Error('stop'));await Promise.resolve();assert.equal(calls,1);assert.deepEqual(n.errors,[sync,asyncError]);
});
