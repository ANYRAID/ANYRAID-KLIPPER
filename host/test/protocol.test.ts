import { test } from 'node:test';
import assert from 'node:assert/strict';
import {encodeInteger,decodeInteger,encodeFrame,checkFrame,FrameDecoder,extendClock,crc16} from '../src/protocol/codec.ts';
const boundaries=[-2147483648,-67108865,-67108864,-524289,-524288,-4097,-4096,-33,-32,-1,0,95,96,12287,12288,1572863,1572864,201326591,201326592,2147483647,2147483648,4294967295];
test('VLQ boundaries and uint32 upper half round-trip without signed shift loss',()=>{
  for(const value of boundaries) {
    const bytes=Uint8Array.from(encodeInteger(value));
    assert.equal(decodeInteger(bytes,0,true).value,value);
    assert.equal(decodeInteger(bytes).value,value>>>0);
    assert.equal(decodeInteger(bytes).next,bytes.length);
  }
  assert.deepEqual(encodeInteger(95),[95]);
  assert.deepEqual(encodeInteger(96),[128,96]);
  assert.deepEqual(encodeInteger(-32),[96]);
  assert.deepEqual(encodeInteger(4294967295),[143,255,255,255,127]);
  for(const value of [NaN,Infinity,1.1,-2147483649,4294967296]) assert.throws(()=>encodeInteger(value));
});
test('truncated, overflowing and overlong integers are rejected',()=>{
  for(const bytes of [[],[128],[128,128,128,128,128,0],[159,255,255,255,127]])
    assert.throws(()=>decodeInteger(Uint8Array.from(bytes)));
  assert.throws(()=>decodeInteger(Uint8Array.from([128,1]),0,false,1));
});
test('frames accept ack, maximum payload and embedded sync; reject each corrupted byte',()=>{
  assert.equal(crc16(new TextEncoder().encode('123456789')),0x6f91);
  for(const payload of [new Uint8Array(),new Uint8Array(59).fill(126)]) {
    const frame=encodeFrame(31,payload);
    assert.equal(frame[1],0x1f); assert.equal(checkFrame(frame),frame.length);
    for(let i=0;i<frame.length;i++) {
      const bad=frame.slice();bad[i]^=1;
      assert.notEqual(checkFrame(bad),frame.length);
    }
  }
  assert.throws(()=>encodeFrame(0,new Uint8Array(60)));
});
test('stream decoder handles every chunk boundary, multiple frames and resync',()=>{
  const a=encodeFrame(0,Uint8Array.from([1,126,2])),b=encodeFrame(1,new Uint8Array());
  const combined=Uint8Array.from([...a,...b]);
  for(let split=0;split<=combined.length;split++) {
    const decoder=new FrameDecoder();
    assert.deepEqual([...decoder.push(combined.slice(0,split)),...decoder.push(combined.slice(split))],[a,b]);
    assert.equal(decoder.bufferedBytes,0);
  }
  const decoder=new FrameDecoder();
  assert.deepEqual(decoder.push(Uint8Array.from([0,1,2,3,4,5,126,...a])),[a]);
  assert.equal(decoder.discardedBytes,7);
  assert.deepEqual(new FrameDecoder().push(Uint8Array.from([126,...b])),[b]);
  const huge=new FrameDecoder(); huge.push(new Uint8Array(1000000));
  assert.ok(huge.bufferedBytes<64); assert.equal(huge.discardedBytes,1000000);
});
test('clock extension stays exact beyond Number.MAX_SAFE_INTEGER and across wraps',()=>{
  assert.equal(extendClock(0xfffffff0n,16),0x100000010n);
  assert.equal(extendClock(0x100000010n,0xfffffff0),0xfffffff0n);
  const high=0x1234567800000010n;
  assert.equal(extendClock(high,32),high+16n);
  assert.equal(extendClock(0xfffffffffffffff0n,16),16n);
  assert.throws(()=>extendClock(high,2**32));
});

import { deflateSync } from 'node:zlib';
import { MessageDictionary } from '../src/protocol/dictionary.ts';
const dictionary={commands:{'queue_step oid=%c interval=%u count=%hu add=%hi':-32,'set_pin pin=%u value=%c':2},responses:{'buffer data=%*s':3,'status clock=%u':4},output:{'value=%u %% buffer=%.*s':5},enumerations:{pin:{PA0:[10,4]}},config:{CLOCK_FREQ:64000000},version:'fixture'};
function identified():MessageDictionary {
  const d=new MessageDictionary();d.identify(deflateSync(JSON.stringify(dictionary)));return d;
}
test('dynamic dictionary encodes negative IDs, enums, signed steps and binary strings',()=>{
  const d=identified();
  const encoded=d.encode('queue_step',{oid:1,interval:0xffffffff,count:20,add:-50});
  const parsed=d.parseFrame(encodeFrame(0,encoded))[0];
  assert.equal(parsed.name,'queue_step');
  assert.deepEqual({...parsed.parameters},{oid:1,interval:0xffffffff,count:20,add:-50});
  assert.deepEqual([...d.encode('set_pin',{pin:'PA3',value:1})],[2,13,1]);
  const bytes=Uint8Array.from([0,255,126]);
  assert.deepEqual(d.parseFrame(encodeFrame(0,d.encode('buffer',{data:bytes})))[0].parameters.data,bytes);
  assert.equal(d.constant('CLOCK_FREQ'),64000000);assert.equal(d.version,'fixture');
  assert.equal(d.lookup('queue_step oid=%c interval=%u count=%hu add=%hi').id,-32);
  assert.throws(()=>d.encode('set_pin',{pin:'PA99',value:1}),/enumeration/);
});
test('identify failure is atomic and decompression has a hard limit',()=>{
  const d=identified(),before=d.rawIdentify;
  assert.throws(()=>d.identify(deflateSync(JSON.stringify({...dictionary,commands:{'bad a=%wat':7}}))));
  assert.deepEqual(d.rawIdentify,before); assert.equal(d.version,'fixture');
  assert.throws(()=>d.identify(deflateSync(Buffer.alloc(4*1024*1024+1))));
  assert.throws(()=>d.identify(deflateSync(JSON.stringify({...dictionary,responses:{'collision':2}}))));
});
test('parser handles multiple messages, acknowledgements, output and unknown IDs',()=>{
  const d=identified();
  assert.deepEqual(d.parseFrame(encodeFrame(0,new Uint8Array())),[]);
  assert.throws(()=>d.parseFrame(new Uint8Array()),/Invalid/);
  const status=d.encode('status',{clock:123});
  assert.equal(d.parseFrame(encodeFrame(0,Uint8Array.from([...status,...status]))).length,2);
  const output=d.parseFrame(encodeFrame(0,Uint8Array.from([5,42,2,65,66])))[0];
  assert.equal(output.name,'#output');assert.equal(output.parameters['0'],42);
  assert.deepEqual(output.parameters['1'],Uint8Array.from([65,66]));
  assert.equal(d.parseFrame(encodeFrame(0,Uint8Array.from([22])))[0].name,'#unknown');
  assert.throws(()=>d.parseFrame(encodeFrame(0,Uint8Array.from([3,8,1]))),/Truncated/);
  assert.throws(()=>d.parseFrame(encodeFrame(0,Uint8Array.from([4,128]))),/Truncated/);
});
