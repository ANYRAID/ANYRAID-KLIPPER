import test from 'node:test';
import assert from 'node:assert/strict';
import {ClockRuntime,type ClockTransport} from '../src/timing/clock-runtime.ts';
import {FakeClock,settle} from './helpers/clock-scheduler.ts';
import {captureClockFaults} from './helpers/clock-fault-diagnostic.ts';

function fixture(){
 const clock=new FakeClock();let queries=0,stops=0;
 const transport:ClockTransport={async uptime(){return {high:0,clock32:1000000,sentTime:clock.time,receiveTime:clock.time};},async queryClock(){queries++;return {clock32:Math.round(1000000+(clock.time-10)*1e6)>>>0,sentTime:clock.time,receiveTime:clock.time};},setClockEstimate(){},async stop(){stops++;}};
 return {clock,transport,get queries(){return queries;},get stops(){return stops;}};
}
test('first retirement captures original expiry before a failed owner can be queried',async t=>{
 const f=fixture(),capture=captureClockFaults(t.mock,()=>f.clock.time),runtime=new ClockRuntime(1e6,f.transport,f.clock);
 const start=runtime.start();await f.clock.advance(.41);await start;await settle();
 const queries=f.queries;f.clock.time+=6;
 assert.throws(()=>runtime.assertActive(),/MCU clock samples expired/);await settle();
 const result=capture.snapshot();assert.equal(result.retirements.length,1);
 assert.equal(result.retirements[0].state,'failed');assert.equal(result.retirements[0].fault!.message,'MCU clock samples expired');
 assert.equal(result.retirements[0].time,f.clock.time);assert.equal(result.retirements[0].samples.count,queries);
 assert.equal(result.retirements[0].samples.warmup!.length,8);assert.equal(f.queries,queries);assert.equal(f.stops,1);
 assert.throws(()=>runtime.assertActive(),/not active/);await runtime.stop();assert.equal(capture.snapshot().retirements.length,1);
 result.retirements[0].fault!.message='changed';assert.equal(capture.snapshot().retirements[0].fault!.message,'MCU clock samples expired');
});
test('async query failure is captured at invalidation with the original identity and stop count',async t=>{
 const f=fixture(),capture=captureClockFaults(t.mock,()=>f.clock.time),original=f.transport.queryClock,cause=new Error('wire unavailable');let count=0;
 f.transport.queryClock=signal=>++count<=8?original(signal):Promise.reject(cause);
 const runtime=new ClockRuntime(1e6,f.transport,f.clock),start=runtime.start();await f.clock.advance(.41);await start;await settle();
 assert.equal(runtime.status.fault,cause);assert.equal(capture.snapshot().retirements[0].fault!.message,cause.message);
 assert.equal(f.queries,8);assert.equal(count,9);assert.equal(f.stops,1);assert.equal(f.clock.pending,0);
});
test('normal stop stays distinct from a fault and uninitialized startup errors propagate',async t=>{
 const f=fixture(),capture=captureClockFaults(t.mock,()=>f.clock.time),runtime=new ClockRuntime(1e6,f.transport,f.clock);
 const start=runtime.start();await f.clock.advance(.41);await start;await runtime.stop();
 assert.equal(capture.snapshot().retirements[0].state,'stopped');assert.equal(capture.snapshot().retirements[0].fault,undefined);assert.equal(f.stops,1);
 const second=fixture(),cause=new Error('uptime absent');second.transport.uptime=async()=>{throw cause;};
 const unavailable=new ClockRuntime(1e6,second.transport,second.clock);await assert.rejects(unavailable.start(),error=>error===cause);
 const owners=capture.snapshot().owners;assert.equal(owners.length,2);assert.equal(owners[1].fault!.message,cause.message);assert.equal(owners[1].samples,undefined);assert.equal(second.stops,1);
});
test('a failed diagnostic sink cannot mask retirement or repeat its first-fault observation',async t=>{
 const f=fixture();let observations=0;const capture=captureClockFaults(t.mock,()=>f.clock.time,()=>{observations++;throw new Error('diagnostic sink failed');});
 const runtime=new ClockRuntime(1e6,f.transport,f.clock),start=runtime.start();await f.clock.advance(.41);await start;
 await runtime.stop();runtime.sync.invalidate();assert.equal(observations,1);assert.equal(f.stops,1);
 assert.equal(capture.snapshot().observerErrors[0].message,'diagnostic sink failed');assert.equal(runtime.status.fault,undefined);assert.equal(runtime.sync.active,false);
});
