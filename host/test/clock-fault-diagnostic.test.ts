import test from 'node:test';
import assert from 'node:assert/strict';
import {ClockRuntime,type ClockTransport} from '../src/timing/clock-runtime.ts';
import {FakeClock,settle} from './helpers/clock-scheduler.ts';
import {captureClockFaults} from './helpers/clock-fault-diagnostic.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {DictionaryClockTransport} from '../src/protocol/clock-transport.ts';

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
 // Permit the required first normal qualification, then fail the first active
 // query. Startup rejection is a separate contract; preserve this fault's identity.
 f.transport.queryClock=signal=>++count<=9?original(signal):Promise.reject(cause);
 const runtime=new ClockRuntime(1e6,f.transport,f.clock),start=runtime.start();await f.clock.advance(.41);await start;await f.clock.advance(1);await settle();
 assert.equal(runtime.status.fault,cause);assert.equal(capture.snapshot().retirements[0].fault!.message,cause.message);
 assert.equal(f.queries,9);assert.equal(count,10);assert.equal(f.stops,1);assert.equal(f.clock.pending,0);
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
test('uptime observation retains exact initial timestamps in a bounded copied ring without additional queries',async t=>{
 const dictionary=new MessageDictionary();dictionary.identify(Buffer.from(JSON.stringify({commands:{get_uptime:2,get_clock:3},responses:{'uptime high=%u clock=%u':4,'clock clock=%u':5},config:{CLOCK_FREQ:1e6}})),false);
 const f=fixture(),capture=captureClockFaults(t.mock,()=>f.clock.time),cause=new Error('uptime query failed');let queries=0,fail=false;
 const connection={async query(){queries++;if(fail)throw cause;return {message:{name:'uptime',parameters:{high:0xf1234567,clock:1000000+queries}},sentTime:10+queries,receiveTime:10+queries+.002};},setClockEstimate(){},async stop(){}};
 const transports=[new DictionaryClockTransport(dictionary,connection),new DictionaryClockTransport(dictionary,connection)],signal=new AbortController().signal;
 for(let i=0;i<20;i++){const sample=await transports[i%2].uptime(signal);assert.equal(sample.clock32,1000001+i);assert.equal(sample.high,0xf1234567);sample.receiveTime=0;}
 const observed=capture.snapshot().uptime;assert.equal(queries,20);assert.equal(observed.count,20);assert.equal(observed.recent.length,16);assert.equal(observed.recent[0].sample.clock32,1000005);assert.equal(observed.recent[0].sample.receiveTime,15.002);assert.equal(observed.recent.at(-1)!.sample.receiveTime,30.002);assert.deepEqual(observed.recent.slice(0,2).map(row=>row.transport),[0,1]);
 observed.recent[0].sample.sentTime=0;assert.equal(capture.snapshot().uptime.recent[0].sample.sentTime,15);fail=true;await assert.rejects(transports[0].uptime(signal),error=>error===cause);assert.equal(queries,21);assert.equal(capture.snapshot().uptime.count,20);
});
