import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ClockRuntime,type ClockTransport,type UptimeSample} from '../src/timing/clock-runtime.ts';
import {ClockSync,type ClockSample,type ReleaseEstimate} from '../src/timing/clock-sync.ts';
import {FakeClock,settle} from './helpers/clock-scheduler.ts';
import {captureClockFaults} from './helpers/clock-fault-diagnostic.ts';
function fixture(epoch=1000000n){
 const clock=new FakeClock(),origin=clock.time,releases:ReleaseEstimate[]=[],queries:number[]=[];let stops=0;
 const ticks=(time:number)=>epoch+BigInt(Math.round((time-origin)*1e6));
 const sample=(delay:number,known=true):Promise<ClockSample>=>{
  const sent=clock.time;
  return new Promise(resolve=>clock.schedule(()=>resolve({clock32:Number(ticks(clock.time)&0xffffffffn),sentTime:known?sent:0,receiveTime:clock.time}),delay));
 };
 const transport:ClockTransport={
  async uptime(){const row=await sample(.004),full=ticks(row.receiveTime);return {...row,high:Number(full>>32n)};},
  queryClock(){queries.push(clock.time);const at=queries.length;return sample(at<=2?.020:at===17?.023470212:.0001);},
  setClockEstimate(row){releases.push(row);},async stop(){stops++;},
 };
 return {clock,transport,ticks,sample,queries,releases,get stops(){return stops;}};
}
test('shorter real reply anchor survives biased uptime and delayed first normal reply without lease changes',async()=>{
 const f=fixture(),runtime=new ClockRuntime(1e6,f.transport,f.clock),start=runtime.start();
 await f.clock.advance(1);assert.equal(runtime.status.state,'starting');assert.equal(f.queries.length,17);assert.throws(()=>runtime.assertActive(),/not active/);
 await f.clock.advance(1);await start;runtime.assertActive();assert.equal(f.queries.length,18);
 const raw=f.queries.slice(0,16);for(let i=1;i<raw.length;i++)assert(raw[i]-raw[i-1]>=.05-1e-12);assert(f.releases.length<=23);
 await f.clock.advance(6);runtime.assertActive();assert(Math.abs(runtime.sync.estimate.frequency-1e6)<1);
 // Independent exact counter oracle; this bound reflects the known 100 us wire
 // interval, not a replacement for any existing numerical/motion tolerance.
 assert(runtime.sync.getClock(f.clock.time)-f.ticks(f.clock.time)<=102n);
 assert(runtime.sync.getClock(f.clock.time)-f.ticks(f.clock.time)>=-102n);
 await runtime.stop();assert.equal(f.stops,1);assert.equal(f.clock.pending,0);
});
test('reanchoring retains full high counter and extends real 32-bit wrap beyond floating integer range',async()=>{
 const f=fixture((1n<<56n)+0xffff0000n),runtime=new ClockRuntime(1e6,f.transport,f.clock),start=runtime.start();
 await f.clock.advance(2);await start;runtime.assertActive();assert(runtime.sync.estimate.origin>1n<<56n);assert.equal(runtime.sync.lastClock,f.ticks(f.queries.at(-1)!+.0001));
 await f.clock.advance(1);runtime.assertActive();assert.equal(runtime.sync.lastClock,f.ticks(f.queries.at(-1)!+.0001));
 assert(runtime.sync.getClock(f.clock.time)-f.ticks(f.clock.time)<=102n);await runtime.stop();assert.equal(f.stops,1);assert.equal(f.clock.pending,0);
});
test('extra calibration is bounded by one stale interval and drains a timed-out query with stop failure visible',async()=>{
 const f=fixture(),original=f.transport.queryClock,stopError=new Error('calibration stop unavailable');let calls=0,aborted=false;
 f.transport.queryClock=s=>++calls<=8?original(s):new Promise(()=>{s.addEventListener('abort',()=>{aborted=true;});});
 f.transport.stop=async()=>{throw stopError;};const runtime=new ClockRuntime(1e6,f.transport,f.clock),failed=assert.rejects(runtime.start(),/timed out/);
 await f.clock.advance(6);await failed;assert.equal(calls,9);assert(aborted);assert.equal(runtime.status.state,'failed');assert.equal(runtime.status.stopError,stopError);assert.equal(runtime.sync.active,false);assert.equal(f.clock.pending,0);
});
test('stop during extra calibration retires both estimator owners and a delayed reply cannot grant motion',async()=>{
 const f=fixture(),original=f.transport.queryClock;let calls=0,complete!:(sample:ClockSample)=>void;
 f.transport.queryClock=s=>++calls<=8?original(s):new Promise(resolve=>{complete=resolve;});
 const runtime=new ClockRuntime(1e6,f.transport,f.clock),cause=new Error('cancel calibration'),failed=assert.rejects(runtime.start(),error=>error===cause);
 await f.clock.advance(.3);const old=runtime.sync;await f.clock.advance(.3);assert.notEqual(runtime.sync,old);assert.equal(old.active,false);assert.equal(runtime.status.state,'starting');assert.throws(()=>runtime.assertActive(),/not active/);
 await runtime.stop(cause);await failed;complete({clock32:1600000,sentTime:10.5,receiveTime:10.6});await settle();assert.equal(runtime.status.state,'stopped');assert.equal(runtime.sync.active,false);assert.equal(f.stops,1);assert.equal(f.clock.pending,0);
});
test('unknown-time recalibration replies cannot inherit provisional releases or grant motion',async()=>{
 const f=fixture();let calls=0;f.transport.queryClock=()=>f.sample(++calls<=2?.02:.0001,calls<=8);
 const runtime=new ClockRuntime(1e6,f.transport,f.clock),failed=assert.rejects(runtime.start(),/No usable clock calibration samples/);
 await f.clock.advance(1);await failed;assert.equal(calls,16);assert.equal(f.releases.length,8);assert.equal(runtime.status.state,'failed');assert.equal(f.stops,1);assert.equal(runtime.sync.active,false);assert.equal(f.clock.pending,0);
});
test('known-time rejected replies after recalibration preserve the original lease and cannot enable readiness',async()=>{
 const f=fixture();let calls=0;
 f.transport.queryClock=async()=>{const row=await f.sample(++calls<=2?.02:.0001);return calls<=16?row:{...row,clock32:(row.clock32+250000)>>>0};};
 const runtime=new ClockRuntime(1e6,f.transport,f.clock),failed=assert.rejects(runtime.start(),/expired/);await f.clock.advance(6);await failed;
 assert.equal(runtime.status.state,'failed');assert.equal(f.stops,1);assert.equal(runtime.sync.active,false);assert.equal(f.clock.pending,0);assert.equal(f.releases.length,16);assert(calls<=22);
});
test('overflow while extending the bootstrap counter fails before reseeding or authorizing motion',async()=>{
 const f=fixture(0xffffffffffff0000n);f.transport.queryClock=()=>f.sample(.02);
 const runtime=new ClockRuntime(1e6,f.transport,f.clock),failed=assert.rejects(runtime.start(),/MCU uptime overflow/);await f.clock.advance(.2);await failed;assert.equal(runtime.status.state,'failed');assert.equal(f.stops,1);assert.equal(runtime.sync.active,false);assert.equal(f.clock.pending,0);
});
test('intentional startup estimator replacement cannot mask the later actual first clock failure',async t=>{
 const f=fixture(),capture=captureClockFaults(t.mock,f.clock.now),runtime=new ClockRuntime(1e6,f.transport,f.clock),start=runtime.start();
 await f.clock.advance(2);await start;assert.equal(capture.snapshot().retirements.length,0);runtime.assertActive();
 f.transport.queryClock=()=>new Promise(()=>{});await f.clock.advance(6);assert.equal(runtime.status.state,'failed');
 const result=capture.snapshot();assert.equal(result.retirements.length,1);assert.equal(result.retirements[0].state,'failed');assert(result.retirements[0].fault?.message.includes('clock query timed out'));assert.equal(result.retirements[0].samples.initial!.uptimeClock,runtime.sync.estimate.origin);assert.equal(f.stops,1);assert.equal(f.clock.pending,0);assert.deepEqual(result.observerErrors,[]);
});
test('actual CI warmup selects the shortest RTT real reply while the new calibration remains fenced',async()=>{
 const evidence=JSON.parse(await readFile(new URL('../contracts/clock-startup-anchor-observation.json',import.meta.url),'utf8')),capture=evidence.captured.samples;
 const warmup=capture.warmup as {sample:ClockSample}[],uptime=evidence.captured.uptime.recent.find((r:{sample:UptimeSample})=>r.sample.sentTime===capture.initial.sentTime).sample as UptimeSample;
 const clock=new FakeClock();clock.time=uptime.sentTime;let calls=0,stops=0,extraSignal:AbortSignal|undefined;
 // The real capture lacks scheduler dispatch times and contains a 49.74 ms
 // warmup gap. Model millisecond timer deadline rounding for this reply prefix;
 // keep every captured reply timestamp/counter and production validation.
 // This is not a claim of complete original transport/scheduler replay.
 const schedule=clock.schedule.bind(clock);clock.schedule=(callback,seconds)=>schedule(callback,seconds===.05?Math.floor((clock.time+seconds)*1000)/1000-clock.time:seconds);
 const transport:ClockTransport={uptime(){return new Promise(resolve=>clock.schedule(()=>resolve({...uptime}),uptime.receiveTime-clock.time));},queryClock(signal){const row=warmup[calls++];if(!row){extraSignal=signal;return new Promise(()=>{});}assert(row.sample.sentTime>=clock.time);return new Promise(resolve=>clock.schedule(()=>resolve({...row.sample}),row.sample.receiveTime-clock.time));},setClockEstimate(){},async stop(){stops++;}};
 const runtime=new ClockRuntime(capture.initial.frequency,transport,clock),cause=new Error('end exact prefix'),failed=assert.rejects(runtime.start(),error=>error===cause);
 await clock.advance(warmup.at(-1)!.sample.receiveTime-clock.time+.051);
 const best=warmup[3].sample,expected=new ClockSync(capture.initial.frequency,BigInt(best.clock32),best.sentTime);
 for(const row of warmup.slice(4))expected.accept(row.sample,true);
 assert.deepEqual(runtime.sync.estimate,expected.estimate);assert.equal(runtime.sync.estimate.origin,BigInt(best.clock32));assert.equal(calls,9);assert.equal(runtime.status.state,'starting');assert.throws(()=>runtime.assertActive(),/not active/);
 await runtime.stop(cause);await failed;assert(extraSignal?.aborted);assert.equal(stops,1);assert.equal(clock.pending,0);
});
