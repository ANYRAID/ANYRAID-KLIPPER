import test from 'node:test';
import assert from 'node:assert/strict';
import {ClockRuntime,type ClockTransport} from '../src/timing/clock-runtime.ts';
import {waitForMcuClocks} from '../src/timing/mcu-clock-barrier.ts';
import {FakeClock,settle} from './helpers/clock-scheduler.ts';
function runtime(time:FakeClock){let samples=0,stops=0,drop=false;const transport:ClockTransport={async uptime(){return {high:0,clock32:1000000,sentTime:time.time,receiveTime:time.time};},async queryClock(){samples++;if(drop)return new Promise(()=>{});return {clock32:Math.round(1000000+(time.time-10)*1e6)>>>0,sentTime:time.time,receiveTime:time.time};},setClockEstimate(){},async stop(){stops++;}};return {clock:new ClockRuntime(1e6,transport,time),get stops(){return stops;},get samples(){return samples;},drop(){drop=true;}};}
async function start(time:FakeClock,...r:ReturnType<typeof runtime>[]){const pending=r.map(x=>x.clock.start());await time.advance(.41);await Promise.all(pending);}
test('real runtime samples advance a multi-MCU barrier only after every target',async()=>{
 const time=new FakeClock(),a=runtime(time),b=runtime(time);await start(time,a,b);let complete=false;
 try{const waiting=waitForMcuClocks([{clock:a.clock,tick:a.clock.sync.lastClock+100000n},{clock:b.clock,tick:b.clock.sync.lastClock+1500000n}],new AbortController().signal,{scheduler:time}).then(()=>{complete=true;});await time.advance(1);assert.equal(complete,false);assert.ok(a.samples>9);await time.advance(1);await waiting;assert.equal(complete,true);a.clock.assertActive();b.clock.assertActive();}finally{await Promise.all([a.clock.stop(),b.clock.stop()]);}assert.equal(time.pending,0);assert.equal(a.stops,1);assert.equal(b.stops,1);
});
test('lost runtime samples fail the barrier and trigger existing transport stop once',async()=>{
 const time=new FakeClock(),r=runtime(time);await start(time,r);r.drop();const result=assert.rejects(waitForMcuClocks([{clock:r.clock,tick:r.clock.sync.lastClock+100000000n}],new AbortController().signal,{scheduler:time,timeoutSeconds:20}),/not active|expired/);await time.advance(6);await result;await settle();assert.equal(r.clock.status.state,'failed');assert.equal(r.clock.sync.active,false);assert.equal(r.stops,1);assert.equal(time.pending,0);
});
test('stopping a runtime cannot satisfy a pending barrier even if its clock had once been healthy',async()=>{
 const time=new FakeClock(),r=runtime(time);await start(time,r);const result=assert.rejects(waitForMcuClocks([{clock:r.clock,tick:r.clock.sync.lastClock+1000000n}],new AbortController().signal,{scheduler:time}),/not active/);await r.clock.stop(new Error('MCU stopped'));await time.advance(.02);await result;assert.equal(r.stops,1);assert.equal(time.pending,0);
});
test('canceling a barrier removes only its own polling and preserves healthy runtime sampling',async()=>{
 const time=new FakeClock(),r=runtime(time);await start(time,r);await settle();const baseline=time.pending,c=new AbortController(),cause=new Error('observation cancelled');const result=assert.rejects(waitForMcuClocks([{clock:r.clock,tick:r.clock.sync.lastClock+1000000n}],c.signal,{scheduler:time}),e=>e===cause);assert.equal(time.pending,baseline+1);c.abort(cause);await result;assert.equal(time.pending,baseline);r.clock.assertActive();const samples=r.samples;await time.advance(1);assert.ok(r.samples>samples);assert.equal(r.stops,0);await r.clock.stop();assert.equal(time.pending,0);
});
test('demand sampling confirms future motion before the next periodic tick without accepting an old sample',async()=>{
 const time=new FakeClock(),r=runtime(time);await start(time,r);await settle();const target=r.clock.sync.lastClock+200000n;let done=false;
 try{const waiting=waitForMcuClocks([{clock:r.clock,tick:target}],new AbortController().signal,{scheduler:time}).then(()=>{done=true;});await time.advance(.15);assert.equal(done,false);await time.advance(.15);await waiting;assert.equal(done,true);assert.ok(r.clock.sync.lastClock>target);assert.ok(r.samples<=15);}finally{await r.clock.stop();}assert.equal(time.pending,0);
});
