import {test} from 'node:test';
import assert from 'node:assert/strict';
import {QueryConnection} from '../src/protocol/queries.ts';
import {DictionaryClockTransport,type TimedResponse} from '../src/protocol/clock-transport.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {encodeFrame} from '../src/protocol/codec.ts';
import {ClockRuntime} from '../src/timing/clock-runtime.ts';
import {FakeClock,settle} from './helpers/clock-scheduler.ts';
const signal=()=>new AbortController().signal;
const response=(clock:FakeClock,name='clock',oid?:number):TimedResponse=>({message:{name,parameters:oid===undefined?{clock:1}:{clock:1,oid}},sentTime:clock.time,receiveTime:clock.time});
test('response is copied and not released until the command is acknowledged',async()=>{
 const clock=new FakeClock();let ack!:()=>void;
 const q=new QueryConnection({send:()=>new Promise(r=>{ack=r;}),setClockEstimate(){},async stop(){}},clock);
 let done=false;const p=q.query(Uint8Array.of(3),'clock',signal()).then(r=>{done=true;return r;});await settle();
 const r=response(clock);assert.equal(q.receive(r),true);r.message.parameters.clock=99;await settle();assert.equal(done,false);ack();assert.equal((await p).message.parameters.clock,1);assert.equal(clock.pending,0);
});
test('routes isolate oid queries, reject duplicate owners, and discard old or unsolicited responses',async()=>{
 const clock=new FakeClock(),acks:(()=>void)[]=[];const q=new QueryConnection({send:()=>new Promise(r=>acks.push(r)),setClockEstimate(){},async stop(){}},clock);
 const p=q.query(Uint8Array.of(3),'clock',signal(),{oid:1}),p2=q.query(Uint8Array.of(3),'clock',signal(),{oid:2});await settle();
 await assert.rejects(q.query(Uint8Array.of(3),'clock',signal(),{oid:1}),/already/);
 assert.equal(q.receive(response(clock,'clock',3)),false);assert.equal(q.receive({...response(clock,'clock',1),sentTime:9,receiveTime:10}),false);
 assert.equal(q.receive(response(clock,'#output')),false);q.receive(response(clock,'clock',2));q.receive(response(clock,'clock',1));acks.forEach(a=>a());
 assert.equal((await p).message.parameters.oid,1);assert.equal((await p2).message.parameters.oid,2);assert.equal(q.status.closed,false);
});
test('read query retries follow the original six-attempt exponential schedule',async()=>{
 const clock=new FakeClock(),times:number[]=[];let q:QueryConnection;
 q=new QueryConnection({async send(){times.push(clock.time);if(times.length===6)q.receive(response(clock));},setClockEstimate(){},async stop(){}},clock);
 const p=q.query(Uint8Array.of(3),'clock',signal(),{retries:5});await clock.advance(.32);await p;
 assert.deepEqual(times.map(t=>Math.round((t-10)*1000)),[0,10,30,70,150,310]);assert.equal(clock.pending,0);
});
test('missing response does not implicitly retry and closes the connection',async()=>{
 const clock=new FakeClock();let writes=0,stops=0;const q=new QueryConnection({async send(){writes++;},setClockEstimate(){},async stop(){stops++;}},clock);
 await assert.rejects(q.query(Uint8Array.of(3),'clock',signal()),/Unable/);await settle();assert.equal(writes,1);assert.equal(stops,1);assert.equal(q.status.closed,true);
});
test('deadline cancels all pending operations even when send ignores abort',async()=>{
 const clock=new FakeClock();let stops=0;const q=new QueryConnection({send:()=>new Promise(()=>{}),setClockEstimate(){},async stop(){stops++;}},clock);
 const p=q.query(Uint8Array.of(3),'clock',signal(),{timeout:.1}),p2=q.query(Uint8Array.of(3),'uptime',signal());
 const failures=Promise.all([assert.rejects(p,/timed out/),assert.rejects(p2,/timed out/)]);await clock.advance(.2);await failures;
 assert.equal(q.status.pending,0);assert.equal(stops,1);assert.equal(clock.pending,0);await assert.rejects(q.query(Uint8Array.of(3),'clock',signal()),/closed/);
});
test('absolute deadline cannot be bypassed by delayed timer callbacks',async()=>{
 const clock=new FakeClock();let ack!:()=>void;const q=new QueryConnection({send:()=>new Promise(r=>{ack=r;}),setClockEstimate(){},async stop(){}},clock);
 const p=q.query(Uint8Array.of(3),'clock',signal());await settle();q.receive(response(clock));clock.time+=6;ack();await assert.rejects(p,/deadline/);assert.equal(clock.pending,0);
});
test('abort during retry backoff cancels timers and preserves stop failure',async()=>{
 const clock=new FakeClock(),abort=new AbortController();let count=0,q:QueryConnection;
 q=new QueryConnection({async send(){count++;},setClockEstimate(){},async stop(){void q.stop('reentrant').catch(()=>{});throw new Error('stop offline');}},clock);
 const p=q.query(Uint8Array.of(3),'clock',abort.signal,{retries:5});await settle();abort.abort(new Error('cancel query'));await assert.rejects(p,/cancel/);await settle();
 assert.equal(count,1);assert.equal(clock.pending,0);assert.match(String(q.status.stopError),/stop offline/);await assert.rejects(q.stop('again'),/stop failed/);
});
test('query routing connects actual protocol frames to clock lifecycle',async()=>{
 const clock=new FakeClock(),d=new MessageDictionary();d.identify(Buffer.from(JSON.stringify({commands:{get_uptime:2,get_clock:3},responses:{'uptime high=%u clock=%u':4,'clock clock=%u':5},config:{CLOCK_FREQ:1e6}})),false);
 let q:QueryConnection,writes=0,estimates=0;
 q=new QueryConnection({async send(payload){writes++;const command=d.parseFrame(encodeFrame(0,payload))[0];const name=command.name==='get_uptime'?'uptime':'clock';const parameters:Record<string,number>=name==='uptime'?{high:0,clock:1e6}:{clock:Math.round(1e6+(clock.time-10)*1e6)};q.receive({message:d.parseFrame(encodeFrame(0,d.encode(name,parameters)))[0],sentTime:clock.time,receiveTime:clock.time});},setClockEstimate(){estimates++;},async stop(){}},clock);
 const transport=new DictionaryClockTransport(d,q),runtime=new ClockRuntime(transport.frequency,transport,clock);const start=runtime.start();await clock.advance(.41);await start;await clock.advance(1);runtime.assertActive();assert.equal(writes,11);assert.equal(estimates,10);await runtime.stop();assert.equal(q.status.closed,true);assert.equal(clock.pending,0);
});
test('identify bootstrap downloads a dictionary through acknowledged queries',async()=>{
 const {deflateSync}=await import('node:zlib'),{downloadIdentify}=await import('../src/protocol/identify.ts');
 const data=deflateSync(Buffer.from(JSON.stringify({commands:{get_clock:2},responses:{'clock clock=%u':3},config:{CLOCK_FREQ:1e6}})));
 const clock=new FakeClock(),bootstrap=new MessageDictionary();let q:QueryConnection,writes=0;
 q=new QueryConnection({async send(payload){writes++;const command=bootstrap.parseFrame(encodeFrame(0,payload))[0],offset=command.parameters.offset as number;const reply=bootstrap.parseFrame(encodeFrame(0,bootstrap.encode('identify_response',{offset,data:data.subarray(offset,offset+40)})))[0];q.receive({message:reply,sentTime:clock.time,receiveTime:clock.time});},setClockEstimate(){},async stop(){}},clock);
 const d=await downloadIdentify(async(payload,signal)=>(await q.query(payload,'identify_response',signal,{retries:5})).message);
 assert.equal(d.constant('CLOCK_FREQ'),1e6);assert.equal(writes,Math.ceil(data.length/40)+1);assert.equal(clock.pending,0);await q.stop('done');
});
test('invalid receive timestamps fence queries and late replies cannot revive them',async()=>{
 const clock=new FakeClock();let stops=0;const q=new QueryConnection({send:()=>new Promise(()=>{}),setClockEstimate(){},async stop(){stops++;}},clock);
 const p=q.query(Uint8Array.of(3),'clock',signal());await settle();assert.throws(()=>q.receive({...response(clock),receiveTime:11}),/timestamps/);await assert.rejects(p,/timestamps/);await settle();assert.equal(stops,1);assert.equal(q.receive(response(clock)),false);assert.equal(clock.pending,0);
});
test('connection bounds concurrent queries without disturbing accepted requests',async()=>{
 const clock=new FakeClock(),q=new QueryConnection({send:()=>new Promise(()=>{}),setClockEstimate(){},async stop(){}},clock);
 const pending=Array.from({length:128},(_,oid)=>assert.rejects(q.query(Uint8Array.of(3),'clock',signal(),{oid}),/end/));
 await assert.rejects(q.query(Uint8Array.of(3),'clock',signal(),{oid:128}),/Too many/);assert.equal(q.status.pending,128);await q.stop(new Error('end'));await Promise.all(pending);assert.equal(clock.pending,0);
});
test('read-only clock adapter explicitly retries a missing response after ACK',async()=>{
 const clock=new FakeClock(),d=new MessageDictionary();d.identify(Buffer.from(JSON.stringify({commands:{get_uptime:2,get_clock:3},responses:{'uptime high=%u clock=%u':4,'clock clock=%u':5},config:{CLOCK_FREQ:1e6}})),false);
 let q:QueryConnection,writes=0;q=new QueryConnection({async send(){if(++writes===2)q.receive(response(clock));},setClockEstimate(){},async stop(){}},clock);
 const transport=new DictionaryClockTransport(d,q),p=transport.queryClock(signal());await clock.advance(.02);assert.equal((await p).clock32,1);assert.equal(writes,2);assert.equal(clock.pending,0);await q.stop('done');
});
