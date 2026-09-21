import test from 'node:test';
import assert from 'node:assert/strict';
import {KlipperSaveChanges} from '../src/config/klipper-save-changes.ts';
test('pending save changes preserve set/remove/recreate semantics and ownership',()=>{const initial={x:{a:'old'}},s=new KlipperSaveChanges(initial);initial.x.a='external';assert.equal(s.capture().values.x.a,'old');s.set('x','a','new');const old=s.status;s.removeSection('x');assert.equal(s.status.save_config_pending_items.x,null);assert.deepEqual(old.save_config_pending_items.x,{a:'new'});s.set('x','b','again');assert.deepEqual(s.status.save_config_pending_items.x,{b:'again'});assert.deepEqual({...s.capture().values.x},{b:'again'});});
test('acknowledging only the current owned snapshot clears pending changes',()=>{const s=new KlipperSaveChanges();s.set('x','a','first');const old=s.capture();assert.ok(Object.isFrozen(old.values.x));s.set('x','a','second');assert.throws(()=>s.acknowledge(old),/Stale/);assert.equal(s.status.save_config_pending,true);assert.equal(s.capture().values.x.a,'second');const latest=s.capture();assert.throws(()=>s.acknowledge({...latest}),/foreign/);s.acknowledge(latest);assert.equal(s.status.save_config_pending,false);assert.deepEqual(Object.keys(s.status.save_config_pending_items),[]);assert.throws(()=>s.acknowledge(latest),/Stale/);});
test('invalid updates do not change revision or pending state and unknown removal is a no-op',()=>{const s=new KlipperSaveChanges({x:{a:'old'}}),before=s.capture();assert.throws(()=>s.set('x','a','1#lost'));assert.throws(()=>s.set('DEFAULT','a','1'));s.removeSection('unknown');assert.equal(s.capture().revision,before.revision);assert.equal(s.status.save_config_pending,false);assert.equal(s.capture().values.x.a,'old');});
test('initial option names normalize once and ambiguous collisions are refused',()=>{const s=new KlipperSaveChanges({x:{VALUE:'old'}});s.set('x','Value','new');assert.deepEqual({...s.capture().values.x},{value:'new'});assert.deepEqual(s.status.save_config_pending_items.x,{Value:'new'});assert.throws(()=>new KlipperSaveChanges({x:{A:'1',a:'2'}}),/Duplicate/);});
test('batch has sequential final semantics with one revision and rolls back a late invalid result',()=>{
 const s=new KlipperSaveChanges({x:{a:'old'}}),before=s.capture();
 assert.throws(()=>s.apply([{kind:'set',section:'x',option:'a',value:'new'},{kind:'set',section:'y',option:'a',value:'1#lost'}]));
 assert.deepEqual(s.capture(),before);assert.equal(s.status.save_config_pending,false);
 s.apply([{kind:'set',section:'x',option:'A',value:'new'},{kind:'remove',section:'x'},{kind:'set',section:'x',option:'B',value:'final'},{kind:'set',section:'__proto__',option:'constructor',value:'safe'}]);
 assert.equal(s.capture().revision,before.revision+1);assert.deepEqual({...s.capture().values.x},{b:'final'});assert.deepEqual(s.status.save_config_pending_items.x,{B:'final'});
 assert.deepEqual(s.status.save_config_pending_items.__proto__,{constructor:'safe'});assert.throws(()=>s.acknowledge(before),/Stale/);
});
test('batch rejects unknown operations and excessive batches before publication; no-op batch retains snapshot',()=>{
 const s=new KlipperSaveChanges(),before=s.capture();
 assert.throws(()=>s.apply(Array(100001).fill({kind:'remove',section:'x'})),/budget/);
 assert.throws(()=>s.apply([{kind:'set',section:'x',option:'a',value:'1'},{kind:'invalid',section:'x'}] as never),/kind/);
 s.apply([]);s.apply([{kind:'remove',section:'unknown'}]);assert.deepEqual(s.capture(),before);s.acknowledge(before);
});
