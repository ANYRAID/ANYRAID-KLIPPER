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
