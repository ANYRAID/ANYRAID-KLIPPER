import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {encodeFrame} from '../src/protocol/codec.ts';
import {DictionaryClockTransport,type TimedResponse} from '../src/protocol/clock-transport.ts';
import {ClockRuntime} from '../src/timing/clock-runtime.ts';
import {FakeClock} from './helpers/clock-scheduler.ts';
function dictionary(frequency:number|string=1e6){const d=new MessageDictionary();d.identify(Buffer.from(JSON.stringify({commands:{get_uptime:2,get_clock:3},responses:{'uptime high=%u clock=%u':4,'clock clock=%u':5},config:{CLOCK_FREQ:frequency}})),false);return d;}
test('dictionary clock commands and responses drive the sampling lifecycle through wire frames',async()=>{
 const d=dictionary(),clock=new FakeClock();let replies=0,stops=0,estimates=0;
 const transport=new DictionaryClockTransport(d,{async query(payload,name,signal){signal.throwIfAborted();const command=d.parseFrame(encodeFrame(0,payload))[0];assert.equal(command.name,name==='uptime'?'get_uptime':'get_clock');const params:Record<string,number>=name==='uptime'?{high:0,clock:1000000}:{clock:Math.round(1000000+(clock.time-10)*1e6)>>>0};const message=d.parseFrame(encodeFrame(0,d.encode(name,params)))[0];replies++;return {message,sentTime:clock.time,receiveTime:clock.time};},setClockEstimate(){estimates++;},async stop(){stops++;}});
 const runtime=new ClockRuntime(transport.frequency,transport,clock),start=runtime.start();await clock.advance(.41);await start;runtime.assertActive();assert.equal(replies,10);assert.equal(estimates,9);await runtime.stop();assert.equal(stops,1);
});
test('dictionary adapter rejects malformed counters and does not accept replies after abort',async()=>{
 let release!:(r:TimedResponse)=>void;const d=dictionary(),transport=new DictionaryClockTransport(d,{query:()=>new Promise(r=>{release=r;}),setClockEstimate(){},async stop(){}});
 const abort=new AbortController(),pending=transport.queryClock(abort.signal);abort.abort(new Error('cancel'));release({message:{name:'clock',parameters:{clock:1}},sentTime:1,receiveTime:1});await assert.rejects(pending,/cancel/);
 const bad=new DictionaryClockTransport(d,{async query(){return {message:{name:'uptime',parameters:{high:-1,clock:0}},sentTime:1,receiveTime:1};},setClockEstimate(){},async stop(){}});await assert.rejects(bad.uptime(new AbortController().signal),/counter/);
 assert.throws(()=>new DictionaryClockTransport(dictionary(0),{} as never),/CLOCK_FREQ/);
});
test('decimal firmware frequency strings retain compatibility without accepting hex coercions',()=>{
 const connection={async query():Promise<never>{throw new Error('unused');},setClockEstimate(){},async stop(){}};
 assert.equal(new DictionaryClockTransport(dictionary('1e6'),connection).frequency,1e6);
 assert.throws(()=>new DictionaryClockTransport(dictionary('0x100'),connection),/CLOCK_FREQ/);
});
