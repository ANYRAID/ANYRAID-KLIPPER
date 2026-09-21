import test from 'node:test';
import assert from 'node:assert/strict';
import {katapultFrame,katapultReply,KatapultRejectedError,flashKatapult} from '../src/diagnostics/katapult.ts';
import {katapultStream} from '../src/diagnostics/katapult-stream.ts';
import {openKatapultSerial} from '../src/diagnostics/katapult-serial.ts';
import {katapultPTY} from './helpers/katapult-pty.ts';
function fixture(reply:(command:number,attempt:number)=>Buffer,signal=new AbortController().signal){
 let pending=Buffer.alloc(0),closed=0;const frames:Buffer[]=[];
 const transport=katapultStream({write(bytes,offset){const frame=Buffer.from(bytes.subarray(offset));frames.push(frame);pending=Buffer.concat([pending,reply(frame[2],frames.length)]);return frame.length;},read(buffer){const n=Math.min(buffer.length,pending.length);pending.copy(buffer,0,0,n);pending=pending.subarray(n);return n;},close(){closed++;}},false,signal);
 return {transport,frames,get closed(){return closed;}};
}
const echo=(command:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(command);return b;};
test('Katapult decodes native eight-byte errors without treating malformed or uncorrelated frames as retryable',()=>{
 for(const ack of [0xf1,0xf2,0xf3])for(const payload of [Buffer.alloc(0),echo(0x11)])assert.throws(()=>katapultReply(0x11,katapultFrame(ack,payload)),e=>e instanceof KatapultRejectedError&&e.acknowledgement===ack);
 for(const bytes of [katapultFrame(0xf1,echo(0x14)),katapultFrame(0xf1,Buffer.alloc(8)),katapultFrame(0x99),katapultFrame(0xa0)])assert.throws(()=>katapultReply(0x11,bytes),e=>!(e instanceof KatapultRejectedError));
 const bad=katapultFrame(0xf1);bad[4]^=1;assert.throws(()=>katapultReply(0x11,bad),/CRC/);
});
test('non-writing parser NACK retries retain the request, wait and stop after five attempts',async()=>{
 const f=fixture((cmd,attempt)=>attempt<5?katapultFrame(0xf1):katapultFrame(0xa0,echo(cmd))),request=katapultFrame(0x11),at=performance.now();
 try{await f.transport.exchange(request,100,new AbortController().signal);assert.equal(f.frames.length,5);assert.ok(f.frames.every(frame=>frame.equals(request)));assert.ok(performance.now()-at>=1900);assert.equal(f.closed,0);}finally{f.transport.close();}
 const exhausted=fixture(()=>katapultFrame(0xf1));await assert.rejects(exhausted.transport.exchange(request,100,new AbortController().signal),KatapultRejectedError);assert.equal(exhausted.frames.length,5);assert.equal(exhausted.closed,1);
});
test('write, EOF, COMPLETE, busy, command error, corrupt NACK and queued extra responses never retry',async()=>{
 for(const [cmd,reply] of [[0x12,katapultFrame(0xf1)],[0x13,katapultFrame(0xf1)],[0x15,katapultFrame(0xf1)],[0x11,katapultFrame(0xf2)],[0x11,katapultFrame(0xf3)],[0x11,Buffer.concat([katapultFrame(0xf1),katapultFrame(0xf1)])]] as const){const f=fixture(()=>reply);await assert.rejects(f.transport.exchange(katapultFrame(cmd),100,new AbortController().signal));assert.equal(f.frames.length,1);assert.equal(f.closed,1);}
 const bad=katapultFrame(0xf1);bad[4]^=1;const f=fixture(()=>bad);await assert.rejects(f.transport.exchange(katapultFrame(0x11),100,new AbortController().signal),/CRC/);assert.equal(f.frames.length,1);assert.equal(f.closed,1);
});
test('cancellation during retry backoff preserves reason and closes without another request',async()=>{
 const controller=new AbortController(),reason=new Error('cancel backoff'),f=fixture(()=>{setTimeout(()=>controller.abort(reason),20);return katapultFrame(0xf1);},controller.signal);
 await assert.rejects(f.transport.exchange(katapultFrame(0x11),100,controller.signal),e=>e===reason);assert.equal(f.frames.length,1);assert.equal(f.closed,1);
});
test('real PTY flash recovers CONNECT, UUID and read-block NACKs without replaying writes',async()=>{
 const peer=katapultPTY({prime:true,nackOnceCommands:[0x11,0x14,0x16]}),signal=new AbortController().signal,serial=openKatapultSerial(peer.path,{prime:true},signal);
 try{const result=await flashKatapult(Buffer.alloc(333,0x99),serial,signal,{expectedUuid:'112233445566'});assert.equal(result.blocks,2);for(const [cmd,count] of [[0x90,1],[0x11,2],[0x16,2],[0x14,3],[0x12,2],[0x13,1],[0x15,1]])assert.equal(peer.commands.filter(c=>c===cmd).length,count);}finally{serial.close();await peer.close();}
});
