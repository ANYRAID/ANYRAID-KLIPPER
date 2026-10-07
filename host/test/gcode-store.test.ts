import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GcodeStore,gcodeStoreCount} from '../src/moonraker/gcode-store.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
import {stateReference} from './helpers/moonraker-state-reference.ts';
test('G-code history matches pinned Python for Unicode whitespace, complete scripts, rollover and count slicing',()=>{
 const counts=[null,0,1,3,-1,-3,100,-100,true,false,2.9,-2.9,1e100,-1e100,' +٠_٣ ','999999999999999999999','-999999999999999999999'];
 const entries=Array.from({length:60},(_,i)=>({message:['G1 X1\nG1 X2','\x85\x1c \n','\ufeff','','ok T:20','中文🙂'][i%6],type:i%2?'command' as const:'response' as const,time:100-i/4}));
 const cases=[0,1,7,100].map(capacity=>({capacity,entries,counts}));
 const oracle=stateReference<unknown>('gcode-test-0',JSON.stringify(cases));
 const actual=cases.map(c=>{let now=0;const store=new GcodeStore(c.capacity,8*1024*1024,()=>now);for(const entry of c.entries){now=entry.time;store.record(entry.message,entry.type);}return counts.map(count=>store.snapshot(gcodeStoreCount(count===null?undefined:count)));});
 assert.deepEqual(actual,oracle);
});
test('G-code history bounds UTF-8 payload, isolates snapshots and does not discard history for oversized incoming records',()=>{
 const store=new GcodeStore(3,8,()=>1);store.record('🙂','response');store.record('中文','command');assert.deepEqual(store.status,{records:1,payloadBytes:6,discarded:1});
 store.record('123456789','response');assert.deepEqual(store.status,{records:1,payloadBytes:6,discarded:2});
 store.record('','response');store.record('ok','response');const result=store.snapshot();result.gcode_store[0].message='changed';result.gcode_store.pop();assert.equal(store.snapshot().gcode_store[0].message,'中文');
 store.record('x','response');assert.deepEqual(store.status,{records:3,payloadBytes:3,discarded:3});
});
test('invalid history count and limits reject explicitly without mutating stored data',()=>{
 for(const count of [null,{},[],NaN,Infinity,'\x1c1','1\x1f','1.2','1__2',' ','0x10','x'.repeat(1025)])assert.throws(()=>gcodeStoreCount(count),e=>e instanceof ApiError&&e.status===400);
 for(const capacity of [-1,1.5,100001])assert.throws(()=>new GcodeStore(capacity),RangeError);
 const store=new GcodeStore(3,100,()=>NaN);assert.throws(()=>store.record('G28','command'),RangeError);assert.equal(store.status.records,0);
 assert.throws(()=>store.snapshot(1.5),RangeError);
});
