import test from 'node:test';
import assert from 'node:assert/strict';
import {StepHistory} from '../src/motion/step-history.ts';
import {StepCompressor} from '../src/motion/step-compressor.ts';
function batch(first:bigint,start:bigint,count:bigint,interval:bigint,add:bigint){const n=count<0n?-count:count,last=first+(n-1n)*interval+add*n*(n-1n)/2n;return {history:new BigInt64Array([first,last,start,count,interval,add]),position:start+count,last};}
test('history counts every exact pulse boundary and adjacent tick without floating roots',()=>{
 for(const [interval,add,n] of [[100n,3n,100n],[1000n,-3n,100n],[999999937n,1n,4n],[100n,0n,100n]])for(const sign of [-1n,1n]){
  const first=(1n<<54n)+100n,h=new StepHistory(first-1n,5n),b=batch(first,5n,n*sign,interval,add);h.append(b,b.last+100n);
  let time=first;assert.equal(h.at(first-1n),5n);
  for(let k=1n;k<=n;k++){if(k>1n)time+=interval+add*(k-1n);assert.equal(h.at(time-1n),5n+(k-1n)*sign);assert.equal(h.at(time),5n+k*sign);}
  assert.equal(h.at(b.last+100n),b.position);
 }
});
test('native flush chunks retain continuous positions and caller buffers cannot mutate history',()=>{
 using compressor=new StepCompressor({frequency:1e6,timeOffset:0,oid:1,maxError:0,queueStepTag:5,directionTag:6});compressor.initializePosition(1000n,23n);const h=new StepHistory(1000n,23n);
 for(let chunk=0;chunk<5;chunk++){
  const steps=new Float64Array(Array.from({length:20},(_,i)=>[chunk%2,(chunk*20+i+2)*.001,0]).flat());compressor.append(steps);const result=compressor.flush();h.append(result,BigInt((chunk*20+21)*1000));result.history.fill(0n);
 }
 for(let i=0;i<100;i++){const direction=Math.floor(i/20)%2?1n:-1n,start=23n-(Math.floor(i/20)%2?20n:0n);assert.equal(h.at(BigInt((i+2)*1000)),start+direction*BigInt(i%20+1));}
});
test('invalid extension is atomic, bounded and cannot invent coverage',()=>{
 const h=new StepHistory(0n,0n,1),b=batch(10n,0n,4n,10n,0n);h.append(b,45n);const before=h.status;
 for(const bad of [{...b,position:99n},{history:new BigInt64Array([50n,80n,4n,4n,10n,0n]),position:8n}])assert.throws(()=>h.append(bad,90n));
 assert.deepEqual(h.status,before);assert.equal(h.at(20n),2n);assert.throws(()=>h.at(46n));assert.throws(()=>h.at(-1n));
 const fresh=new StepHistory(0n,0n);for(const row of [[10n,20n,0n,4n,10n,0n],[10n,10n,0n,0n,1n,0n],[10n,11n,0n,4n,0n,0n]])assert.throws(()=>fresh.append({history:new BigInt64Array(row),position:4n},30n));assert.equal(fresh.status.rows,0);
});
test('idle frontiers and initial observation markers preserve position without steps',()=>{
 const h=new StepHistory(10n,123n);h.append({history:new BigInt64Array([10n,10n,123n,0n,0n,0n]),position:123n},20n);assert.equal(h.at(10n),123n);assert.equal(h.at(20n),123n);h.append({history:new BigInt64Array(),position:123n},30n);assert.equal(h.at(30n),123n);
});
import {homingPositionOffsets} from '../src/homing/position-offsets.ts';
test('homing offsets use each MCU clock domain and distinguish first sample from halted position',()=>{
 const a=new StepHistory(0n,0n),b=new StepHistory(1000n,100n);a.append(batch(10n,0n,10n,10n,0n),100n);b.append(batch(1010n,100n,-10n,10n,0n),1100n);
 const result={hitClock:25n,reasons:[1,2],positions:[{member:0,oid:1,raw:3,position:3n,observedClock:50n},{member:1,oid:1,raw:97,position:97n,observedClock:1050n}]};
 const bindings=[{member:0,oid:1,history:a},{member:1,oid:1,history:b}],offsets=homingPositionOffsets(result,bindings,[25n,1025n]);
 assert.deepEqual(offsets.map(p=>[p.start,p.trigger,p.halt,p.triggerOffset,p.haltOffset,p.overshoot]),[[0n,2n,3n,2n,3n,1n],[100n,98n,97n,-2n,-3n,-1n]]);
 assert.throws(()=>homingPositionOffsets({...result,hitClock:null},bindings,[25n,1025n]),/did not trigger/);
 assert.throws(()=>homingPositionOffsets(result,bindings,[25n,25n]),/outside/);
 assert.throws(()=>homingPositionOffsets(result,bindings,[25n,2000n]),/mapped/);
 assert.throws(()=>homingPositionOffsets(result,[bindings[0],bindings[0]],[25n,1025n]),/Duplicate/);
});
test('maximum supported history batch does not depend on function argument limits',()=>{
 const rows=200000,data=new BigInt64Array(rows*6);for(let i=0;i<rows;i++){const clock=BigInt(i+1);data.set([clock,clock,BigInt(i),1n,1n,0n],(rows-i-1)*6);}
 const h=new StepHistory(0n,0n,rows);h.append({history:data,position:BigInt(rows)},BigInt(rows));assert.equal(h.at(123456n),123456n);assert.equal(h.status.rows,rows);
});

test('pruning preserves every remaining exact pulse and gap across signed quadratic rows',()=>{
 for(const sign of [-1n,1n])for(const add of [-2n,0n,2n]){
  const first=(1n<<54n)+100n,b=batch(first,17n,20n*sign,100n,add),next=batch(b.last+100n,b.position,-10n*sign,100n,0n);
  for(let offset=0n;offset<=next.last-first+30n;offset+=13n){
   const original=new StepHistory(first-1n,17n),trimmed=new StepHistory(first-1n,17n);for(const h of [original,trimmed]){h.append(b,b.last);h.append(next,next.last+30n);}
   const cutoff=first+offset;trimmed.pruneBefore(cutoff);assert.throws(()=>trimmed.at(cutoff-1n),/outside/);
   for(let t=cutoff;t<=next.last+30n;t+=7n)assert.equal(trimmed.at(t),original.at(t));
   if(cutoff<=next.last)assert.equal(trimmed.at(next.last),original.at(next.last));
  }
 }
});
test('pruning reclaims capacity, keeps markers and append continuity, and rejects invalid cutoffs atomically',()=>{
 const h=new StepHistory(0n,0n,2);h.append(batch(10n,0n,3n,10n,0n),35n);h.append(batch(40n,3n,-3n,10n,0n),65n);
 assert.equal(h.pruneBefore(30n),1);assert.equal(h.at(30n),3n);h.append(batch(70n,0n,1n,10n,0n),80n);assert.equal(h.at(70n),1n);
 assert.equal(h.pruneBefore(80n),2);assert.equal(h.status.rows,0);assert.equal(h.at(80n),1n);
 h.append({history:new BigInt64Array([80n,80n,1n,0n,0n,0n]),position:1n},90n);assert.equal(h.pruneBefore(90n),1);
 const before=h.status;for(const cutoff of [89n,91n,-1n])assert.throws(()=>h.pruneBefore(cutoff));assert.deepEqual(h.status,before);
 assert.throws(()=>h.append(batch(90n,1n,1n,10n,0n),100n));h.append(batch(91n,1n,-1n,10n,0n),100n);assert.equal(h.at(91n),0n);
});
test('nested pins preserve homing baseline and release idempotently without bypassing capacity',()=>{
 const h=new StepHistory(0n,0n,1);h.append(batch(10n,0n,3n,10n,0n),40n);const a=h.pin(),b=h.pin();
 assert.equal(h.pruneBefore(40n),0);a();a();assert.equal(h.pruneBefore(40n),0);assert.equal(h.at(0n),0n);
 assert.throws(()=>h.append(batch(50n,3n,1n,10n,0n),60n),/capacity/);b();assert.equal(h.pruneBefore(40n),1);assert.equal(h.at(40n),3n);
});
test('rolling history compaction survives many times its bounded capacity',()=>{
 const h=new StepHistory(0n,0n,2048);
 for(let i=1;i<=20000;i++){const t=BigInt(i);if(i>1500)h.pruneBefore(t-1500n);h.append(batch(t,t-1n,1n,1n,0n),t);assert.equal(h.at(t),t);assert(h.status.rows<=1500);if(i>1500)assert.equal(h.at(t-1500n),t-1500n);}
 assert.equal(h.status.lastPlannedPosition,20000n);
});
