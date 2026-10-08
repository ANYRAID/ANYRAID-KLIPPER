import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ClockRuntime,type ClockTransport} from '../src/timing/clock-runtime.ts';
import type {ClockSample,ReleaseEstimate} from '../src/timing/clock-sync.ts';
import {FakeClock,settle} from './helpers/clock-scheduler.ts';
function fixture(){
 const clock=new FakeClock();let queries=0,stops=0;const estimates:ReleaseEstimate[]=[];
 const transport:ClockTransport={async uptime(){return {high:0,clock32:1000000,sentTime:clock.time,receiveTime:clock.time};},async queryClock(){queries++;return {clock32:Math.round(1000000+(clock.time-10)*1e6)>>>0,sentTime:clock.time,receiveTime:clock.time};},setClockEstimate(e){estimates.push(e);},async stop(){stops++;}};
 return {clock,transport,estimates,get queries(){return queries;},get stops(){return stops;}};
}
test('startup cannot grant motion while the first ordinary reply is pending',async()=>{
 const f=fixture(),original=f.transport.queryClock;let replies=0,complete!:()=>void,resolved=false;
 f.transport.queryClock=async s=>{const sample=await original(s);return ++replies<=8?sample:new Promise(resolve=>{complete=()=>resolve({...sample,receiveTime:f.clock.time});});};
 const runtime=new ClockRuntime(1e6,f.transport,f.clock),start=runtime.start().then(()=>{resolved=true;});
 await f.clock.advance(.41);assert.equal(resolved,false);assert.equal(runtime.status.state,'starting');assert.equal(runtime.status.inFlight,true);assert.throws(()=>runtime.assertActive(),/not active/);
 complete();await start;runtime.assertActive();assert.equal(f.estimates.length,9);
 await runtime.stop();assert.equal(f.stops,1);assert.equal(f.clock.pending,0);
});
test('an isolated unusable startup reply is retried on the existing periodic route',async()=>{
 const f=fixture(),original=f.transport.queryClock;let replies=0;
 f.transport.queryClock=async s=>{const sample=await original(s);return ++replies===9?{...sample,sentTime:0}:sample;};
 const runtime=new ClockRuntime(1e6,f.transport,f.clock),start=runtime.start();await f.clock.advance(.41);
 assert.equal(runtime.status.state,'starting');assert.equal(f.queries,9);assert.equal(f.estimates.length,8);assert.throws(()=>runtime.requestSample(),/not active/);
 await f.clock.advance(1);await start;runtime.assertActive();assert.equal(f.queries,10);assert.equal(f.estimates.length,9);
 await f.clock.advance(.9839);assert.equal(f.queries,11);await runtime.stop();assert.equal(f.clock.pending,0);
});
for(const known of [true,false])test('unusable ordinary startup replies cannot extend the original lease: known='+known,async()=>{
 const f=fixture(),original=f.transport.queryClock;let replies=0,ready=false;
 f.transport.queryClock=async s=>{const sample=await original(s);return ++replies<=8?sample:known?{...sample,clock32:(sample.clock32+250000)>>>0}:{...sample,sentTime:0};};
 const runtime=new ClockRuntime(1e6,f.transport,f.clock),start=runtime.start().then(()=>{ready=true;});const failed=assert.rejects(start,/expired/);
 await f.clock.advance(5.32);await failed;assert.equal(ready,false);assert.equal(runtime.status.state,'failed');assert.equal(f.estimates.length,8);assert.equal(f.stops,1);assert.equal(runtime.sync.active,false);assert.equal(f.clock.pending,0);
 assert.equal(f.clock.time,15.32);await runtime.stop();assert.equal(f.stops,1);
});
test('an unanswered qualification expires startup and preserves stop failure',async()=>{
 const f=fixture(),original=f.transport.queryClock;let replies=0;const stopError=new Error('stop unavailable');
 f.transport.queryClock=s=>++replies<=8?original(s):new Promise(()=>{});f.transport.stop=async()=>{throw stopError;};
 const runtime=new ClockRuntime(1e6,f.transport,f.clock),failed=assert.rejects(runtime.start(),/timed out/);
 await f.clock.advance(5.32);await failed;assert.equal(runtime.status.stopError,stopError);assert.equal(runtime.status.state,'failed');assert.equal(runtime.sync.active,false);assert.equal(f.clock.pending,0);
});
test('explicit stop cancels qualification and cannot permit a delayed reply to activate',async()=>{
 const f=fixture(),original=f.transport.queryClock;let replies=0,complete!:(sample:ClockSample)=>void;
 f.transport.queryClock=s=>++replies<=8?original(s):new Promise(resolve=>{complete=resolve;});
 const runtime=new ClockRuntime(1e6,f.transport,f.clock),cause=new Error('operator stopped startup'),failed=assert.rejects(runtime.start(),error=>error===cause);
 await f.clock.advance(.41);await runtime.stop(cause);await failed;complete({clock32:1410000,sentTime:10.4,receiveTime:10.41});await settle();
 assert.equal(runtime.status.state,'stopped');assert.equal(f.estimates.length,8);assert.equal(f.stops,1);assert.equal(f.clock.pending,0);
});
test('captured biased warmup does not grant motion after its first rejected ordinary reply',async()=>{
 const bytes=await readFile(new URL('../contracts/clock-warmup-wire-counterexample.json',import.meta.url));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),'d55c01ed59138c67cd9efb99e874ff9c29f2dd9eacde761e93cf00bd51fec672');
 const evidence=JSON.parse(bytes.toString()),capture=evidence.captures.find((c:{id:string})=>c.id==='aux'),rows=[...capture.warmup,capture.recent[0]];
 const clock=new FakeClock();clock.time=capture.initial.sentTime;let at=0,stops=0,ready=false;const estimates:ReleaseEstimate[]=[];
 const transport:ClockTransport={async uptime(){const value=BigInt(capture.initial.uptimeClock);return {high:Number(value>>32n),clock32:Number(value&0xffffffffn),sentTime:clock.time,receiveTime:clock.time};},queryClock(){const row=rows[at++];assert.ok(row,'Only nine captured replies are admitted by this fixture.');assert.ok(row.sample.sentTime>=clock.time);return new Promise(resolve=>clock.schedule(()=>resolve({...row.sample}),row.sample.receiveTime-clock.time));},setClockEstimate(e){estimates.push(e);},async stop(){stops++;}};
 const runtime=new ClockRuntime(capture.initial.frequency,transport,clock),cause=new Error('end captured prefix'),start=runtime.start().then(()=>{ready=true;}),failed=assert.rejects(start,error=>error===cause);
 await clock.advance(rows.at(-1).sample.receiveTime-clock.time+.000001);
 assert.equal(ready,false);assert.equal(runtime.status.state,'starting');assert.equal(at,9);assert.equal(estimates.length,8);
 assert.deepEqual(runtime.sync.estimate,{...rows.at(-1).after,origin:BigInt(rows.at(-1).after.origin)});assert.equal(rows.at(-1).release,null);assert.throws(()=>runtime.assertActive(),/not active/);
 await runtime.stop(cause);await failed;assert.equal(stops,1);assert.equal(clock.pending,0);
 // Uptime receive time was absent from the capture; this is an estimator-input
 // prefix fixture, not a full transport replay or a recovered physical clock.
});
