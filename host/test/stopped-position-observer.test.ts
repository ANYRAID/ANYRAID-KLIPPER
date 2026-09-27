import test from 'node:test';
import assert from 'node:assert/strict';
import {registerStoppedPositionObserver,observeStoppedPosition} from '../src/motion/stopped-position-observer.ts';
const signal=()=>new AbortController().signal;
test('stopped observers isolate session/OID identity, retain exact counts and detach idempotently',async()=>{
 const a={},b={},seen:bigint[]=[];const detach=registerStoppedPositionObserver(a,4,async p=>{seen.push(p);});
 assert.throws(()=>registerStoppedPositionObserver(a,4,async()=>{}),/owned/);await observeStoppedPosition(b,4,2n,signal());await observeStoppedPosition(a,5,3n,signal());assert.equal(seen.length,0);
 await observeStoppedPosition(a,4,-9007199254740993n,signal());assert.deepEqual(seen,[-9007199254740993n]);detach();detach();await observeStoppedPosition(a,4,0n,signal());assert.equal(seen.length,1);
 const remove=registerStoppedPositionObserver(a,4,async p=>{seen.push(p);});detach();await observeStoppedPosition(a,4,1n,signal());assert.equal(seen.at(-1),1n);remove();
});
test('stopped barrier joins callbacks and propagates failures or late cancellation',async()=>{
 const session={},pending=Promise.withResolvers<void>(),abort=new AbortController();let finished=false;
 const detach=registerStoppedPositionObserver(session,0,async()=>pending.promise);const work=observeStoppedPosition(session,0,0n,abort.signal).then(()=>{finished=true;});await Promise.resolve();assert.equal(finished,false);abort.abort(new Error('cancel phase'));pending.resolve();await assert.rejects(work,/cancel phase/);detach();
 const fail=registerStoppedPositionObserver(session,0,async()=>{throw new Error('read lost');});await assert.rejects(observeStoppedPosition(session,0,0n,signal()),/read lost/);fail();
});
test('old detach cannot remove a new registration even with the same callback',async()=>{
 const session={};let calls=0;const callback=async()=>{calls++;},old=registerStoppedPositionObserver(session,2,callback);old();const fresh=registerStoppedPositionObserver(session,2,callback);old();await observeStoppedPosition(session,2,0n,signal());assert.equal(calls,1);fresh();
});
