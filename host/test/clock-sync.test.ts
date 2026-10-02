import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ClockSync} from '../src/timing/clock-sync.ts';
function feed(sync:ClockSync,origin:bigint,count=100):void {
  for(let i=1;i<=count;i++) sync.accept({clock32:Number((origin+BigInt(i*64000000))&0xffffffffn),sentTime:10+i,receiveTime:10+i+.002},i<=8);
}
test('clock regression tracks constant frequency through uint32 wrap',()=>{
  const sync=new ClockSync(64000000,0n,10);feed(sync,0n);
  assert.equal(sync.lastClock,6400000000n);
  assert.ok(Math.abs(sync.estimate.frequency-64000000)<1e-7);
  assert.ok(Math.abs(Number(sync.getClock(110.001))-6400000000)<=1);
  assert.ok(Math.abs(sync.systemTime(6400000000n)-110.001)<1e-12);
});
test('large MCU uptime stays exact and invariant under bigint origin translation',()=>{
  const origin=0xf123456700000000n,a=new ClockSync(64000000,0n,10),b=new ClockSync(64000000,origin,10);
  feed(a,0n);feed(b,origin);
  assert.equal(b.getClock(110.1)-a.getClock(110.1),origin);
  assert.equal(b.lastClock-a.lastClock,origin);
  assert.equal(a.estimate.frequency,b.estimate.frequency);
});
test('unknown send times extend clocks but do not contaminate regression',()=>{
  const sync=new ClockSync(1000000,0n,10),before=sync.estimate;
  for(let i=0;i<5;i++) sync.querySent();assert.equal(sync.active,false);
  assert.equal(sync.accept({clock32:10000,sentTime:0,receiveTime:11}),null);
  assert.deepEqual(sync.estimate,before);assert.equal(sync.lastClock,10000n);assert.equal(sync.active,true);
});
test('stale timestamps and invalid clocks fail before clock mutation',()=>{
  const sync=new ClockSync(1000000,100000n,10);
  for(const sample of [{clock32:1,sentTime:9,receiveTime:10},{clock32:-1,sentTime:11,receiveTime:12},{clock32:1,sentTime:11,receiveTime:10}])
    assert.throws(()=>sync.accept(sample));
  assert.equal(sync.lastClock,100000n);
});
test('nearest clock may go backwards while received samples advance',()=>{
  const sync=new ClockSync(1000000,0x100000010n,10);
  assert.equal(sync.nearestClock(0xfffffff0),0xfffffff0n);
  assert.equal(sync.nearestClock(0x20),0x100000020n);
});
test('long-running regression rebases while preserving origin translation and tick precision',()=>{
  const origin=0x8123456700000000n,a=new ClockSync(64000000,0n,10),b=new ClockSync(64000000,origin,10);
  feed(a,0n,20000);feed(b,origin,20000);
  assert.ok(a.estimate.origin>0n);
  assert.equal(b.getClock(20010.001)-a.getClock(20010.001),origin);
  assert.ok(Math.abs(Number(a.getClock(20010.001))-1280000000000)<=1);
});
test('warmup retransmission still resets the following outlier recovery window',()=>{
 const sync=new ClockSync(1000,0n,10);sync.accept({clock32:1000,sentTime:11,receiveTime:11},true);
 assert.equal(sync.accept({clock32:2000,sentTime:0,receiveTime:12},true),null);
 assert.notEqual(sync.accept({clock32:3500,sentTime:13,receiveTime:13}),null);
});
