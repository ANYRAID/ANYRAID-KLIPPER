import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeLm75,Lm75Sensor} from '../src/thermal/lm75.ts';
const signal=()=>new AbortController().signal;
test('LM75 exhausts all register words with signed half-degree resolution and ignored low bits',()=>{
 for(let raw=0;raw<65536;raw++){const signed=raw>=32768?raw-65536:raw;assert.equal(decodeLm75(Uint8Array.of(raw>>>8,raw&255)),Math.floor(signed/128)*.5);}
 for(const [raw,expected] of [[0xfa00,-6],[0xff80,-.5],[0xe700,-25],[0xc900,-55],[0x7d00,125]])assert.equal(decodeLm75(Uint8Array.of(raw>>>8,raw&255)),expected);
 for(const size of [0,1,3])assert.throws(()=>decodeLm75(Buffer.alloc(size)),/Malformed/);
});
test('LM75 starts without optional ID and preserves conversion waits on forced reads',async()=>{
 let now=0,last=0,reads=0;const commands:number[][]=[],waits:number[]=[],abort=new AbortController();
 const sensor=new Lm75Sensor({async transfer(bytes,n){commands.push([...bytes]);if(n===1){last=now;return Uint8Array.of(0);}assert(now-last>=500);last=now;reads++;return Uint8Array.of(255,128);}},async(ms,s)=>{waits.push(ms);now+=ms;s.throwIfAborted();},()=>now);
 assert.deepEqual(await sensor.initialize(signal()),{temperature:-.5});await sensor.sample(signal());assert.deepEqual(commands,[[1],[0],[0]]);assert.deepEqual(waits,[500,500]);
 now+=800;await sensor.sample(signal());assert.equal(waits.length,2);await assert.rejects(sensor.initialize(signal()),/restart/);
 abort.abort();await assert.rejects(sensor.sample(abort.signal));assert.equal(reads,3);
});
test('LM75 faults latch and cancellation during wait prevents sensor access',async()=>{
 for(const mode of ['shutdown','malformed','cancel']){let calls=0;const abort=new AbortController(),sensor=new Lm75Sensor({async transfer(_bytes,n){calls++;return n===1?Uint8Array.of(mode==='shutdown'?1:0):Buffer.alloc(1);}},async()=>{if(mode==='cancel')abort.abort(new Error('cancel'));},()=>1000);
  // For malformed data, advance through the first conversion without a real timer.
  if(mode==='malformed'){const bad=new Lm75Sensor({async transfer(_bytes,n){calls++;return n===1?Uint8Array.of(0):Buffer.alloc(1);}},async()=>{},(()=>{let t=0;return()=>t+=1000;})());await assert.rejects(bad.initialize(signal()),/Malformed/);const count=calls;await assert.rejects(bad.sample(signal()),/Malformed/);assert.equal(calls,count);continue;}
  await assert.rejects(sensor.initialize(abort.signal),mode==='shutdown'?/shutdown/:/cancel/);assert.equal(calls,1);
 }
});
