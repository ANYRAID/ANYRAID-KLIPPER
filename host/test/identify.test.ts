import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {downloadIdentify} from '../src/protocol/identify.ts';
import type {IdentifyQuery} from '../src/protocol/identify.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {encodeFrame} from '../src/protocol/codec.ts';
const raw={commands:{'get_clock':2},responses:{'clock clock=%u':3},version:'test-firmware',config:{CLOCK_FREQ:120000000}};
const data=deflateSync(JSON.stringify(raw));
function peer(bytes:Uint8Array=data):{query:IdentifyQuery; offsets:number[]} {
  const bootstrap=new MessageDictionary(),offsets:number[]=[];
  return {offsets,query:async(payload,signal)=>{
    signal.throwIfAborted();
    const command=bootstrap.parseFrame(encodeFrame(0,payload))[0];
    assert.equal(command.name,'identify');assert.equal(command.parameters.count,40);
    const offset=command.parameters.offset as number;offsets.push(offset);
    return bootstrap.parseFrame(encodeFrame(0,bootstrap.encode('identify_response',{offset,data:bytes.slice(offset,offset+40)})))[0];
  }};
}
test('identify transfers 40-byte chunks through the actual wire codec and validates before publishing',async()=>{
  const p=peer(),dictionary=await downloadIdentify(p.query);
  assert.equal(dictionary.version,raw.version);assert.equal(dictionary.constant('CLOCK_FREQ'),120000000);
  assert.deepEqual(dictionary.lookup('get_clock'),{id:2,name:'get_clock'});
  assert.equal(p.offsets.at(-1),data.length);
  assert.ok(p.offsets.slice(1,-1).every(offset=>offset%40===0));
});
test('stale offsets retry the same position and bounded no-progress fails',async()=>{
  const p=peer();let calls=0;
  const dictionary=await downloadIdentify(async(payload,signal)=>{
    if(calls++===0) return {name:'identify_response',parameters:{offset:99,data:new Uint8Array([1])}};
    return p.query(payload,signal);
  });
  assert.equal(dictionary.version,raw.version);
  let count=0;
  await assert.rejects(downloadIdentify(async()=>{count++;return {name:'identify_response',parameters:{offset:1,data:new Uint8Array()}};},{maxStaleResponses:2}),/no progress/);
  assert.equal(count,3);
});
test('malformed, oversized, empty and invalid compressed dictionaries are rejected',async()=>{
  for(const parameters of [{offset:-1,data:new Uint8Array()},{offset:0,data:'bad'},{offset:0,data:new Uint8Array(41)}])
    await assert.rejects(downloadIdentify(async()=>({name:'identify_response',parameters})),/Malformed/);
  await assert.rejects(downloadIdentify(peer(new Uint8Array()).query),/Empty/);
  await assert.rejects(downloadIdentify(peer().query,{maxBytes:40}),/limit/);
  await assert.rejects(downloadIdentify(peer(Uint8Array.from([1,2,3])).query));
});
test('timeout aborts a query that never returns and pre-abort sends nothing',async()=>{
  let captured:AbortSignal|undefined;
  await assert.rejects(downloadIdentify(async(_payload,signal)=>{captured=signal;return new Promise(()=>{});},{timeoutMs:10}),/timed out/);
  assert.equal(captured!.aborted,true);
  const abort=new AbortController();abort.abort(new Error('User cancelled'));
  let calls=0;
  await assert.rejects(downloadIdentify(async()=>{calls++;throw new Error('must not send');},{signal:abort.signal}),/User cancelled/);
  assert.equal(calls,0);
});
test('in-flight abort releases the caller and aborts the transport signal',async()=>{
  const abort=new AbortController();let started:()=>void=()=>{};
  const ready=new Promise<void>(resolve=>{started=resolve;});
  let captured:AbortSignal|undefined;
  const pending=downloadIdentify(async(_payload,signal)=>{captured=signal;started();return new Promise(()=>{});},{signal:abort.signal});
  await ready;abort.abort(new Error('Disconnected'));
  await assert.rejects(pending,/Disconnected/);assert.equal(captured!.aborted,true);
});
