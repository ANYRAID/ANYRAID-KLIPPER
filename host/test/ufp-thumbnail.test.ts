import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {externalAcceptanceBundle,assertAcceptanceBundleUnchanged} from './helpers/acceptance-bundle.ts';
const retained=await externalAcceptanceBundle();if(retained)after(()=>assertAcceptanceBundleUnchanged(retained));
const {preparePngThumbnailImages,prepareThumbnailImages}=retained?await import(pathToFileURL(join(retained.path,'host/src/moonraker/thumbnail-images.js')).href) as typeof import('../src/moonraker/thumbnail-images.ts'):await import('../src/moonraker/thumbnail-images.ts');
const {ThumbnailProcessor}=retained?await import(pathToFileURL(join(retained.path,'host/src/moonraker/thumbnail-process.js')).href) as typeof import('../src/moonraker/thumbnail-process.ts'):await import('../src/moonraker/thumbnail-process.ts');
const signal=()=>new AbortController().signal;
const png=(width=64,height=32)=>sharp({create:{width,height,channels:4,background:{r:12,g:34,b:56,alpha:0.5}}}).png().toBuffer();

test('Cura external PNG uses Lanczos while inline cubic and original bytes remain unchanged',async()=>{
 const raw=Buffer.alloc(96*64*3);for(let i=0;i<raw.length;i++)raw[i]=(i*43+(i>>>4)*17)&255;
 const input=await sharp(raw,{raw:{width:96,height:64,channels:3}}).png().toBuffer(),processor=await ThumbnailProcessor.open();
 try{const images=await processor.prepareUfpPng(input,signal()),expected=await sharp(raw,{raw:{width:96,height:64,channels:3}}).resize(32,21,{fit:'fill',kernel:'lanczos3',withoutEnlargement:true}).png().toBuffer();assert.equal(images[0].width,32);assert.equal(images[0].height,21);assert.deepEqual(images[0].bytes,expected);assert.deepEqual(images[1].bytes,input);const cubic=await processor.preparePng(input,signal());assert.notDeepEqual(images[0].bytes,cubic[0].bytes);assert.deepEqual(cubic[1].bytes,input);}finally{await processor.close();}
});

test('archive PNG preserves exact bytes and matches inline decoded miniature output',async()=>{
 const bytes=await png(),base64=bytes.toString('base64');
 const inline=await prepareThumbnailImages(`; thumbnail begin 64x32 ${base64.length}\n; ${base64}\n; thumbnail end\n`,signal());
 const images=await preparePngThumbnailImages(bytes,signal());assert.deepEqual(images,inline);
 assert.deepEqual(images[1].bytes,bytes);assert.equal(images[0].width,32);assert.equal(images[0].height,16);
 bytes.fill(0);assert.notEqual(images[1].bytes[0],0);
});
test('archive PNG dimensions and strict full decoding reject invalid content',async()=>{
 await assert.rejects(preparePngThumbnailImages(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),signal()),/signature/);
 const jpeg=await sharp({create:{width:32,height:32,channels:3,background:'red'}}).jpeg().toBuffer();
 await assert.rejects(preparePngThumbnailImages(jpeg,signal()),/signature/);
 const bytes=await png();await assert.rejects(preparePngThumbnailImages(bytes.subarray(0,33),signal()));
 await assert.rejects(preparePngThumbnailImages(await png(2049,1),signal()),/dimensions/);
 await assert.rejects(preparePngThumbnailImages(Buffer.alloc(4*1024**2+1),signal()),/limit/);
 await assert.rejects(preparePngThumbnailImages(bytes,AbortSignal.abort(new Error('archive cancelled'))),/archive cancelled/);
});
test('archive PNG uses isolated IPC and a 32 square original needs no duplicate miniature',async()=>{
 const bytes=await png(32,32),processor=await ThumbnailProcessor.open();
 try{const images=await processor.preparePng(bytes,signal());assert.equal(images.length,1);assert.deepEqual(images[0].bytes,bytes);assert.equal(images[0].miniature,false);assert.equal(processor.status.bytes,0);}
 finally{await processor.close();}
});
test('mixed text and archive queues retain owned bytes and cancellation releases only queued work',async()=>{
 const bytes=await png(32,32),expected=Buffer.from(bytes),processor=await ThumbnailProcessor.open({maxPending:3,maxQueuedBytes:bytes.length});
 try{
  process.kill(processor.status.pid!,'SIGSTOP');const active=processor.prepare('',signal()),controller=new AbortController();
  const cancelled=processor.preparePng(bytes,controller.signal);assert.equal(processor.status.bytes,bytes.length);
  await assert.rejects(processor.preparePng(bytes,signal()),/queue is full/);
  controller.abort(new Error('queued archive cancelled'));await assert.rejects(cancelled,/queued archive cancelled/);
  assert.equal(processor.status.closed,false);assert.equal(processor.status.bytes,0);
  const replacement=processor.preparePng(bytes,signal());bytes.fill(0);
  process.kill(processor.status.pid!,'SIGCONT');assert.deepEqual(await active,[]);assert.deepEqual((await replacement)[0].bytes,expected);
  assert.equal(processor.status.pending,0);assert.equal(processor.status.bytes,0);
 }finally{await processor.close();}
});
test('invalid archive input is rejected before admission and a decode error leaves child usable',async()=>{
 const processor=await ThumbnailProcessor.open();try{
  await assert.rejects(processor.preparePng(Buffer.alloc(4*1024**2+1),signal()),/limit/);
  await assert.rejects(processor.preparePng(await png(),AbortSignal.abort(new Error('preabort'))),/preabort/);
  assert.equal(processor.status.pending,0);
  await assert.rejects(processor.preparePng(Buffer.from('invalid'),signal()),/signature/);
  assert.equal(processor.status.closed,false);assert.deepEqual(await processor.prepare('',signal()),[]);
 }finally{await processor.close();}
});
test('active archive cancellation kills the original child and rejects mixed queued work without replay',async()=>{
 const bytes=await png(),processor=await ThumbnailProcessor.open(),pid=processor.status.pid!;
 try{
  process.kill(pid,'SIGSTOP');const controller=new AbortController(),active=processor.preparePng(bytes,controller.signal),queued=processor.prepare('',signal());
  const settled=Promise.allSettled([active,queued]);controller.abort(new Error('active archive cancelled'));
  assert((await settled).every(result=>result.status==='rejected'));await processor.close();
  assert.throws(()=>process.kill(pid,0),/ESRCH/);assert.equal(processor.status.closed,true);assert.equal(processor.status.bytes,0);
  await assert.rejects(processor.preparePng(bytes,signal()),/closed/);
 }finally{await processor.close();}
});
