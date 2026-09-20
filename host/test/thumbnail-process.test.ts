import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {ThumbnailProcessor} from '../src/moonraker/thumbnail-process.ts';
const signal=()=>new AbortController().signal;
const gone=(pid:number)=>assert.throws(()=>process.kill(pid,0),/ESRCH/);
test('thumbnail process returns Buffer payloads and preserves originals across IPC',async()=>{
 const processor=await ThumbnailProcessor.open();try{const bytes=await sharp({create:{width:32,height:32,channels:3,background:'red'}}).png().toBuffer(),base64=bytes.toString('base64'),text=`; thumbnail begin 32x32 ${base64.length}\n; ${base64}\n; thumbnail end\n`,images=await processor.prepare(text,signal());assert.equal(images.length,1);assert.ok(Buffer.isBuffer(images[0].bytes));assert.deepEqual(images[0].bytes,bytes);assert.equal(images[0].width,32);assert.equal(processor.status.pending,0);assert.equal(processor.status.bytes,0);}finally{const pid=processor.status.pid!;await processor.close();gone(pid);}
});
test('queue byte/count caps and queued cancellation preserve the active child',async()=>{
 const processor=await ThumbnailProcessor.open({maxPending:2,maxQueuedBytes:12});try{process.kill(processor.status.pid!,'SIGSTOP');const active=processor.prepare('12345678',signal()),controller=new AbortController(),queued=processor.prepare('1234',controller.signal);await assert.rejects(processor.prepare('1',signal()),/queue is full/);assert.equal(processor.status.bytes,12);controller.abort(new Error('queued cancellation'));await assert.rejects(queued,/queued cancellation/);assert.equal(processor.status.closed,false);assert.equal(processor.status.bytes,8);const replacement=processor.prepare('abcd',signal());process.kill(processor.status.pid!,'SIGCONT');assert.deepEqual(await active,[]);assert.deepEqual(await replacement,[]);assert.equal(processor.status.bytes,0);}finally{await processor.close();}
});
test('pre-abort and invalid inputs do not reserve jobs or poison the process',async()=>{
 const processor=await ThumbnailProcessor.open();try{await assert.rejects(processor.prepare('',AbortSignal.abort(new Error('preabort'))),/preabort/);await assert.rejects(processor.prepare('x'.repeat(2*1024**2+1),signal()),/limit/);assert.equal(processor.status.pending,0);assert.deepEqual(await processor.prepare('',signal()),[]);await assert.rejects(ThumbnailProcessor.open({maxPending:0}),/capacity/);}finally{await processor.close();}
});
test('active cancellation kills the child and rejects queued tasks without automatic restart',async()=>{
 const processor=await ThumbnailProcessor.open(),pid=processor.status.pid!;try{process.kill(pid,'SIGSTOP');const controller=new AbortController(),active=processor.prepare('',controller.signal),queued=processor.prepare('',signal()),settled=Promise.allSettled([active,queued]);controller.abort(new Error('active cancellation'));assert.ok((await settled).every(result=>result.status==='rejected'));await processor.close();gone(pid);assert.equal(processor.status.closed,true);assert.equal(processor.status.bytes,0);await assert.rejects(processor.prepare('',signal()),/closed/);}finally{await processor.close();}
});
test('hard deadline terminates even a stopped child and releases all tasks',async()=>{
 const processor=await ThumbnailProcessor.open({timeoutMs:20}),pid=processor.status.pid!;try{process.kill(pid,'SIGSTOP');await assert.rejects(processor.prepare('',signal()),/timed out/);await processor.close();gone(pid);assert.equal(processor.status.pending,0);}finally{await processor.close();}
});
test('unexpected child death rejects active/queued work; close is idempotent',async()=>{
 const processor=await ThumbnailProcessor.open(),pid=processor.status.pid!;try{process.kill(pid,'SIGSTOP');const requests=Promise.allSettled([processor.prepare('',signal()),processor.prepare('',signal())]);process.kill(pid,'SIGKILL');assert.ok((await requests).every(result=>result.status==='rejected'));const a=processor.close(),b=processor.close();assert.equal(a,b);await a;gone(pid);}finally{await processor.close();}
});
test('malformed image errors are isolated to their job and the child remains usable',async()=>{
 const processor=await ThumbnailProcessor.open();try{await assert.rejects(processor.prepare('; thumbnail begin 32x32 4\n; YQ==\n; thumbnail end\n',signal()),/signature/);assert.equal(processor.status.closed,false);assert.deepEqual(await processor.prepare('',signal()),[]);}finally{await processor.close();}
});
