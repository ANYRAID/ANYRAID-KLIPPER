import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {HistoryTracker,historyStrategies} from '../src/moonraker/history-tracker.ts';
import type {Json} from '../src/moonraker/rpc.ts';
import {historyTrackerOracle} from './helpers/history-tracker-oracle.ts';
type Op={kind:'state';active:boolean;paused:boolean}|{kind:'update';value:Json}|{kind:'reset';value?:Json};
test('all seven trackers match pinned Moonraker through reset, pause and new job sequences',()=>{
 const ops:Op[]=[{kind:'update',value:100},{kind:'reset'}, {kind:'state',active:true,paused:false}];
 for(const value of [-12,-3,0.1,true,false,null,'ignored',{a:[true]}, {a:[1]},[true],[1],7])ops.push({kind:'update',value});
 ops.push({kind:'state',active:true,paused:true},{kind:'update',value:20},{kind:'update',value:30},{kind:'state',active:true,paused:false},{kind:'update',value:32},{kind:'state',active:false,paused:false},{kind:'update',value:500},{kind:'reset',value:10},{kind:'state',active:true,paused:false},{kind:'update',value:12});
 for(const initial of [null,'bad',-5,true,[1,2]]){ops.push({kind:'reset',value:initial});for(let i=0;i<120;i++)ops.push({kind:'update',value:i/8});}
 let seed=173;for(let i=0;i<150;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;ops.push({kind:'update',value:(seed-2**31)/1234567});}
 const cases=historyStrategies.flatMap(strategy=>[false,true].map(exclude=>({strategy,exclude,ops})));
 const child=spawnSync('python3',['-c',historyTrackerOracle()+'\nprint(json.dumps([run(c) for c in json.load(sys.stdin)]))'],{input:JSON.stringify(cases),encoding:'utf8',maxBuffer:8*1024*1024});assert.equal(child.status,0,child.stderr);
 const expected=JSON.parse(child.stdout);
 for(const [index,c] of cases.entries()){
  let active=false,paused=false;const t=new HistoryTracker({strategy:c.strategy,excludePaused:c.exclude,trackingEnabled:exclude=>active&&!(exclude&&paused)});
  const values=c.ops.map(op=>{if(op.kind==='state'){active=op.active;paused=op.paused;}else if(op.kind==='update')t.update(op.value);else{t.setResetCallback(op.value===undefined?undefined:()=>op.value!);t.reset();}return {value:t.value,totals:t.hasTotals};});
  assert.deepEqual(values,expected[index],`${c.strategy}, exclude=${c.exclude}`);
 }
});
test('tracker snapshots own JSON and rejected oversize updates leave state intact',()=>{
 for(const strategy of ['basic','collect'] as const){
  const t=new HistoryTracker({strategy,trackingEnabled:()=>true}),value={a:[1]};t.update(value);value.a.push(2);
  assert.deepEqual(t.value,strategy==='basic'?{a:[1]}:[{a:[1]}]);
  const copy=t.value as Json[]|Record<string,Json>;if(Array.isArray(copy))copy.push('external');else copy.extra=true;
  const before=t.value;assert.throws(()=>t.update('x'.repeat(65537)));assert.deepEqual(t.value,before);
  t.setResetCallback(()=>('x'.repeat(65537)));assert.throws(()=>t.reset());assert.deepEqual(t.value,before);
 }
});
test('numeric overflow rejects without corrupting previous accumulator or delta baseline',()=>{
 for(const strategy of ['accumulate','average','delta'] as const){
  const t=new HistoryTracker({strategy,trackingEnabled:()=>true});t.reset();t.update(0);t.update(1e308);const previous=t.value;
  assert.throws(()=>t.update(strategy==='delta'?-1e308:1e308));assert.equal(t.value,previous);
  assert.throws(()=>t.update(NaN));assert.equal(t.value,previous);
 }
});
test('runtime instances keep independent pause gates and reset retains basic values',()=>{
 let paused=true;const a=new HistoryTracker({strategy:'delta',excludePaused:true,trackingEnabled:exclude=>!(exclude&&paused)}),b=new HistoryTracker({strategy:'delta',trackingEnabled:()=>true});
 for(const t of [a,b]){t.update(1);t.update(3);}assert.equal(a.value,0);assert.equal(b.value,2);paused=false;a.update(4);assert.equal(a.value,1);
 a.setExcludePaused(false);paused=true;a.update(6);assert.equal(a.value,3);
 const basic=new HistoryTracker({strategy:'basic',trackingEnabled:()=>true});basic.update('kept');basic.reset();assert.equal(basic.value,'kept');
});
test('collection byte accounting handles reset, eviction and rejected aggregate size',()=>{
 const first='a'.repeat(32760),second='b'.repeat(32760);
 const t=new HistoryTracker({strategy:'collect',trackingEnabled:()=>true,reset:()=>[first,second]});t.reset();
 assert.throws(()=>t.update('c'.repeat(20)));assert.deepEqual(t.value,[first,second]);
 t.setResetCallback(()=>Array.from({length:100},(_,i)=>String(i)));t.reset();t.update('replacement');
 assert.deepEqual(t.value,[...Array.from({length:99},(_,i)=>String(i+1)),'replacement']);
 t.setResetCallback(undefined);t.reset();t.update(true);t.update(1);t.update(false);t.update(0);assert.deepEqual(t.value,[true,false]);
});
