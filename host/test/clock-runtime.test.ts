import {test} from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {ClockRuntime,type ClockTransport} from '../src/timing/clock-runtime.ts';
import {FakeClock,settle} from './helpers/clock-scheduler.ts';
function fixture(){const clock=new FakeClock();let queries=0,stops=0,estimates=0;const queryTimes:number[]=[];
 const transport:ClockTransport={async uptime(){return {high:0,clock32:1000000,sentTime:clock.time,receiveTime:clock.time};},async queryClock(){queries++;queryTimes.push(clock.time);return {clock32:Math.round(1000000+(clock.time-10)*1e6)>>>0,sentTime:clock.time,receiveTime:clock.time};},setClockEstimate(){estimates++;},async stop(){stops++;}};
 return {clock,transport,get queries(){return queries;},get stops(){return stops;},get estimates(){return estimates;},queryTimes};}
test('clock runtime warms eight samples and schedules nonresonant queries without leaking timers',async()=>{
 const f=fixture(),r=new ClockRuntime(1e6,f.transport,f.clock),start=r.start();await f.clock.advance(.41);await start;r.assertActive();assert.equal(f.queries,9);assert.equal(f.estimates,9);
 await f.clock.advance(1);assert.equal(f.queries,10);assert(Math.abs(f.queryTimes[9]-f.queryTimes[8]-.9839)<1e-12);
 await r.stop();assert.equal(f.stops,1);assert.equal(f.clock.pending,0);assert.equal(r.sync.active,false);await assert.rejects(r.start(),/restart/);
});
test('a transport ignoring abort still cannot keep startup alive beyond its deadline',async()=>{
 const f=fixture();let aborted=false;f.transport.uptime=signal=>{signal.addEventListener('abort',()=>{aborted=true;});return new Promise(()=>{});};
 const r=new ClockRuntime(1e6,f.transport,f.clock),result=assert.rejects(r.start(),/timed out/);await f.clock.advance(5.1);await result;assert(aborted);assert.equal(r.status.state,'failed');assert.equal(f.stops,1);assert.equal(f.clock.pending,0);
});
test('an unanswered active query expires authorization and invalidates the estimator',async()=>{
 const f=fixture(),original=f.transport.queryClock;let count=0;f.transport.queryClock=s=>++count<=8?original(s):new Promise(()=>{});
 const r=new ClockRuntime(1e6,f.transport,f.clock),start=r.start();await f.clock.advance(.41);await start;await f.clock.advance(5);
 assert.equal(r.status.state,'failed');assert.equal(r.sync.active,false);assert.throws(()=>r.assertActive());assert.equal(count,9);assert.equal(f.stops,1);assert.equal(f.clock.pending,0);
});
test('a stalled host cannot renew stale authorization with a late fresh-looking reply',async()=>{
 const f=fixture(),original=f.transport.queryClock;let count=0,reply!:(sample:{clock32:number;sentTime:number;receiveTime:number})=>void;
 f.transport.queryClock=s=>++count<=8?original(s):new Promise(resolve=>{reply=resolve;});const r=new ClockRuntime(1e6,f.transport,f.clock),start=r.start();await f.clock.advance(.41);await start;
 f.clock.time+=6;reply({clock32:8000000,sentTime:f.clock.time,receiveTime:f.clock.time});await settle();assert.equal(r.status.state,'failed');assert.equal(f.stops,1);assert.equal(r.sync.active,false);
});
test('unusable warmup, malformed timestamps and failed stop remain visible',async()=>{
 const f=fixture();f.transport.queryClock=async()=>({clock32:1000000,sentTime:0,receiveTime:f.clock.time});f.transport.stop=async()=>{throw new Error('stop offline');};const r=new ClockRuntime(1e6,f.transport,f.clock),result=assert.rejects(r.start(),/usable/);await f.clock.advance(.5);await result;assert(r.status.stopError instanceof Error);assert.equal(r.sync.active,false);
 const g=fixture();g.transport.queryClock=async()=>({clock32:1000000,sentTime:g.clock.time,receiveTime:g.clock.time+1});const second=new ClockRuntime(1e6,g.transport,g.clock),invalid=assert.rejects(second.start(),/timestamps/);await g.clock.advance(.1);await invalid;assert.equal(g.stops,1);
});
test('default monotonic timers complete initialization and stop cleanly',async()=>{
 const sample=()=>{const now=performance.now()/1000;return {clock32:Math.floor(now*1e6)>>>0,sentTime:now,receiveTime:now};};
 const r=new ClockRuntime(1e6,{async uptime(){return {...sample(),high:0};},async queryClock(){return sample();},setClockEstimate(){},async stop(){}});
 await r.start();r.assertActive();await r.stop();assert.equal(r.status.state,'stopped');
});
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
test('expired sampling prevents native motion generation and fences the coordinator',async()=>{
 const f=fixture(),runtime=new ClockRuntime(1e6,f.transport,f.clock),start=runtime.start();await f.clock.advance(.41);await start;
 using q=new TrapQueue();q.setPosition(1,0,0,0);q.appendRaw(new Float64Array([1.5,0,1,0,0,0,0,1,0,0,1,1,0]));using s=q.createStepper({frequency:1e6,timeOffset:0,initialClock:1000000n,oid:3,maxError:0,queueStepTag:5,directionTag:6},'x',.01);let stops=0;
 const c=new MotionCoordinator([{id:'x',queue:q,stepper:s}],{async commit(){},async stop(){stops++;}},16*1024*1024,1,[runtime]);
 await c.advanceWindow(1.7,1.65);f.clock.time+=6;
 await assert.rejects(c.advanceWindow(2,1.95),/expired/);assert.equal(s.generatedTime,1.7);assert.equal(c.status.failed,true);assert.equal(stops,1);await settle();assert.equal(f.stops,1);assert.equal(runtime.sync.active,false);
});
test('clock health also fences calibration before changing a native mapping',async()=>{
 using q=new TrapQueue();using s=q.createStepper({frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6},'x',.01);let stops=0;
 const c=new MotionCoordinator([{id:'x',queue:q,stepper:s}],{async commit(){},async stop(){stops++;}},16*1024*1024,0,[{assertActive(){throw new Error('expired clock');}}]);
 assert.throws(()=>c.calibrateClock(['x'],0,1000100),/expired/);assert.equal(s.clockAt(1),1000000n);assert.equal(c.status.failed,true);await settle();assert.equal(stops,1);
});
test('reentrant cancellation still invokes the connection stop only once',async()=>{
 const f=fixture();let runtime:ClockRuntime;f.transport.uptime=signal=>{signal.addEventListener('abort',()=>{void runtime.stop();});return new Promise(()=>{});};runtime=new ClockRuntime(1e6,f.transport,f.clock);
 const result=assert.rejects(runtime.start(),/stopped/);await settle();await runtime.stop();await result;assert.equal(f.stops,1);assert.equal(runtime.status.state,'stopped');assert.equal(f.clock.pending,0);
});
test('demand samples are bounded, share periodic ownership, and cannot revive a stopped clock',async()=>{
 const f=fixture(),r=new ClockRuntime(1e6,f.transport,f.clock),start=r.start();await f.clock.advance(.41);await start;await settle();const base=f.queries;
 for(let i=0;i<100;i++)r.requestSample();await settle();assert.equal(f.queries,base);
 await f.clock.advance(.05);let reply!:()=>void,requests=0;const original=f.transport.queryClock;
 f.transport.queryClock=s=>new Promise(resolve=>{requests++;reply=()=>{void original(s).then(resolve);};});
 r.requestSample();await settle();assert.equal(r.status.inFlight,true);
 // A periodic tick and repeated consumers must not acquire another query route.
 await f.clock.advance(1);for(let i=0;i<100;i++)r.requestSample();await settle();assert.equal(f.queries,base);assert.equal(requests,1);
 reply();await settle();assert.equal(f.queries,base+1);assert.equal(r.status.inFlight,false);
 const before=f.queries;for(let i=0;i<100;i++){r.requestSample();await settle();}assert.equal(f.queries,before);assert.equal(requests,2);
 await r.stop();assert.throws(()=>r.requestSample(),/not active/);assert.equal(f.clock.pending,0);assert.equal(f.stops,1);
});
test('frequent demand refresh remains rate limited and does not change the sampled clock semantics',async()=>{
 const f=fixture(),r=new ClockRuntime(1e6,f.transport,f.clock),start=r.start();await f.clock.advance(.41);await start;await settle();const before=f.queries,old=r.sync.lastClock;
 for(let i=0;i<100;i++){r.requestSample();await f.clock.advance(.001);}assert.ok(f.queries-before<=2);assert.ok(r.sync.lastClock>old);r.assertActive();await r.stop();assert.equal(f.clock.pending,0);
});
test('known-time rejected responses cannot renew the motion clock lease',async()=>{
 const f=fixture(),runtime=new ClockRuntime(1e6,f.transport,f.clock),start=runtime.start();await f.clock.advance(.41);await start;await settle();
 const usable=f.estimates,original=f.transport.queryClock,initial=runtime.sync.lastClock;
 f.transport.queryClock=async signal=>{const sample=await original(signal);return {...sample,clock32:(sample.clock32+250000)>>>0};};
 await f.clock.advance(4);runtime.assertActive();assert.equal(f.estimates,usable);assert(runtime.sync.lastClock>initial);
 await f.clock.advance(1.1);assert.equal(runtime.status.state,'failed');assert.equal(f.stops,1);assert.equal(runtime.sync.active,false);assert.equal(f.clock.pending,0);
 assert.throws(()=>runtime.assertActive());await runtime.stop();assert.equal(f.stops,1);
});
test('unknown departure replies advance raw clock but cannot renew the motion clock lease',async()=>{
 const f=fixture(),runtime=new ClockRuntime(1e6,f.transport,f.clock),start=runtime.start();await f.clock.advance(.41);await start;await settle();
 const usable=f.estimates,original=f.transport.queryClock,initial=runtime.sync.lastClock;
 f.transport.queryClock=async signal=>({...await original(signal),sentTime:0});
 await f.clock.advance(4);runtime.assertActive();assert.equal(f.estimates,usable);assert(runtime.sync.lastClock>initial);
 await f.clock.advance(1.1);assert.equal(runtime.status.state,'failed');assert.equal(f.stops,1);assert.equal(runtime.sync.active,false);assert.equal(f.clock.pending,0);
});
test('an isolated rejected response preserves the lease and a usable response renews it before expiry',async()=>{
 const f=fixture(),runtime=new ClockRuntime(1e6,f.transport,f.clock),start=runtime.start();await f.clock.advance(.41);await start;await settle();
 const usable=f.estimates,original=f.transport.queryClock;let rejected=0;
 f.transport.queryClock=async signal=>{const sample=await original(signal);return ++rejected===1?{...sample,sentTime:0}:sample;};
 await f.clock.advance(1);runtime.assertActive();assert.equal(f.estimates,usable);
 await f.clock.advance(5);runtime.assertActive();assert(f.estimates>usable);assert.equal(f.stops,0);
 await runtime.stop();assert.equal(f.stops,1);assert.equal(f.clock.pending,0);
});
test('unusable trailing warmup replies cannot move the usable estimate deadline',async()=>{
 const f=fixture(),original=f.transport.queryClock;let requests=0;
 f.transport.queryClock=async signal=>{const sample=await original(signal);return ++requests===1?sample:{...sample,sentTime:0};};
 const runtime=new ClockRuntime(1e6,f.transport,f.clock),start=runtime.start();await f.clock.advance(.41);await start;await settle();assert.equal(f.estimates,1);
 await f.clock.advance(4.4);runtime.assertActive();assert.equal(f.stops,0);
 await f.clock.advance(.2);assert.throws(()=>runtime.assertActive(),/expired/);await settle();assert.equal(f.stops,1);assert.equal(runtime.sync.active,false);assert.equal(f.clock.pending,0);
});
