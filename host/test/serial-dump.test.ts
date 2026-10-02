import test from 'node:test';
import assert from 'node:assert/strict';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {encodeFrame} from '../src/protocol/codec.ts';
import {SerialDumpDecoder,formatDumpMessage} from '../src/diagnostics/serial-dump.ts';
const dictionary=new MessageDictionary();dictionary.identify(Buffer.from(JSON.stringify({commands:{'queue_step oid=%c interval=%u count=%hu add=%hi':2},responses:{'bytes data=%.*s':3},output:{'value %i %% %.*s':4}})),false);
const frame=encodeFrame(0,Uint8Array.from([2,4,32,8,127]));
test('dump decodes fixed wire integers at every byte split including multi-message frames',()=>{
 const both=encodeFrame(1,Uint8Array.from([2,4,32,8,127,3,3,0,39,255]));
 for(let split=0;split<=both.length;split++){const d=new SerialDumpDecoder(dictionary);assert.equal([...d.push(both.subarray(0,split)),...d.push(both.subarray(split))].join(''),"queue_step oid=4 interval=32 count=8 add=-1\nbytes data=b'\\x00\\'\\xff'\n");d.finish();assert.equal(d.messages,2);}
});
test('dump byte recovery retains valid frames without waiting for a sync marker',()=>{
 const d=new SerialDumpDecoder(dictionary);assert.equal([...d.push(Buffer.concat([Buffer.from([0,0]),frame]))].join(''),'queue_step oid=4 interval=32 count=8 add=-1\n');d.finish();assert.equal(d.discardedBytes,2);
});
test('empty ACK is silent, truncation and malformed message fail explicitly',()=>{
 const d=new SerialDumpDecoder(dictionary);assert.deepEqual([...d.push(encodeFrame(0,new Uint8Array()))],[]);d.finish();assert.equal(d.frames,1);
 const short=new SerialDumpDecoder(dictionary);[...short.push(frame.subarray(0,-1))];assert.throws(()=>short.finish(),/Truncated/);
 assert.throws(()=>[...new SerialDumpDecoder(dictionary).push(encodeFrame(0,Uint8Array.from([3,10,0])))],/Truncated string/);
});
test('output escapes percent and binary bytes; unknown messages retain full wire bytes',()=>{
 assert.equal([...new SerialDumpDecoder(dictionary).push(encodeFrame(0,Uint8Array.from([4,127,1,10])))].join(''),"#output value -1 % b'\\n'\n");
 assert.equal(formatDumpMessage({name:'#unknown',parameters:{'#msg':Uint8Array.from([0,255])}}),"#unknown b'\\x00\\xff'");
});
test('CLI reads files, reports corrupt bytes and returns failure for truncated input',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises'),{join}=await import('node:path'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const dir=await mkdtemp('/tmp/dump-cli-test-');try{
  const dict=join(dir,'firmware.dict'),data=join(dir,'capture.serial');await writeFile(dict,dictionary.rawIdentify);await writeFile(data,Buffer.concat([Buffer.from([0]),frame]));
  const script=new URL('../../scripts/parsedump.ts',import.meta.url),run=promisify(execFile),{fileURLToPath}=await import('node:url');
  const result=await run(process.execPath,[fileURLToPath(script),dict,data]);assert.equal(result.stdout,'queue_step oid=4 interval=32 count=8 add=-1\n');assert.match(result.stderr,/discarded 1 bytes/);
  await writeFile(data,frame.subarray(0,-1));await assert.rejects(run(process.execPath,[fileURLToPath(script),dict,data]),(error:any)=>error.code===1&&/Truncated serial dump/.test(error.stderr));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('checksum corruption recovers, enums and uint32 remain exact',()=>{
 const broken=Uint8Array.from(frame);broken[broken.length-2]^=1;const d=new SerialDumpDecoder(dictionary);
 assert.equal([...d.push(Buffer.concat([broken,frame]))].join(''),'queue_step oid=4 interval=32 count=8 add=-1\n');d.finish();assert.equal(d.discardedBytes,broken.length);
 const enumDict=new MessageDictionary();enumDict.identify(Buffer.from(JSON.stringify({commands:{'pin pin=%u clock=%u':2},responses:{},enumerations:{pin:{PA0:0}}})),false);
 assert.equal([...new SerialDumpDecoder(enumDict).push(encodeFrame(0,Uint8Array.from([2,0,255,255,255,255,127])))].join(''),'pin pin=PA0 clock=4294967295\n');
});
