import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import qoi from 'qoijs';
import {decodeThumbnailBase64,parseThumbnailBlocks} from '../src/moonraker/thumbnail-blocks.ts';
import {prepareThumbnailImages} from '../src/moonraker/thumbnail-images.ts';
const signal=()=>new AbortController().signal;
const block=(bytes:Buffer,width:number,height:number,format='png')=>{const b64=bytes.toString('base64');return `; thumbnail_${format} begin ${width}x${height} ${b64.length}\n; ${b64}\n; thumbnail_${format} end\n`;};
test('base64 follows Python padding and ignored characters rather than Node leniency',()=>{
 for(const text of ['YQ==','=YQ==','Y=Q==','YQ==junk','Y_Q=='])assert.equal(decodeThumbnailBase64(text).toString(),'a');
 assert.equal(decodeThumbnailBase64('YQ=Q=').toString('hex'),'6104');assert.equal(decodeThumbnailBase64('====').length,0);for(const text of ['Y','YQ','YQQ','YQ='])assert.throws(()=>decodeThumbnailBase64(text),/padding/);
});
test('thumbnail envelopes preserve supported format and length skips with bounded dimensions/count',()=>{
 const data=block(Buffer.from('a'),32,32);assert.equal(parseThumbnailBlocks(data,signal())[0].bytes.toString(),'a');assert.equal(parseThumbnailBlocks(data.replace(' 4\n',' 5\n'),signal()).length,0);assert.equal(parseThumbnailBlocks(data.replaceAll('thumbnail_png','thumbnail_bmp'),signal()).length,0);
 assert.throws(()=>parseThumbnailBlocks(data.replace('32x32','4096x32'),signal()),/dimensions/);assert.throws(()=>parseThumbnailBlocks(data.repeat(65),signal()),/count/);assert.throws(()=>parseThumbnailBlocks('thumbnail begin '.repeat(65),signal()),/count/);assert.throws(()=>parseThumbnailBlocks(data,AbortSignal.abort(new Error('cancel'))),/cancel/);
});
test('PNG and JPEG are validated and preserved while miniature dimensions fit without upscaling',async()=>{
 for(const format of ['png','jpg'] as const){const pipeline=sharp({create:{width:80,height:40,channels:3,background:'#123456'}}),bytes=await (format==='png'?pipeline.png():pipeline.jpeg()).toBuffer(),images=await prepareThumbnailImages(block(bytes,80,40,format),signal());assert.equal(images.length,2);assert.equal(images[0].width,32);assert.equal(images[0].height,16);assert.equal(images[0].miniature,true);assert.deepEqual(images[1].bytes,bytes);}
 const bytes=await sharp({create:{width:10,height:5,channels:3,background:'red'}}).png().toBuffer();const images=await prepareThumbnailImages(block(bytes,10,5),signal());assert.equal(images[0].width,10);assert.equal(images[0].height,5);
});
test('existing 32-square suppresses automatic miniature and rejects mismatched or corrupt images',async()=>{
 const bytes=await sharp({create:{width:32,height:32,channels:3,background:'red'}}).png().toBuffer();assert.equal((await prepareThumbnailImages(block(bytes,32,32),signal())).length,1);
 await assert.rejects(prepareThumbnailImages(block(bytes,64,32),signal()),/mismatch/);await assert.rejects(prepareThumbnailImages(block(bytes.subarray(0,40),32,32),signal()));await assert.rejects(prepareThumbnailImages(block(bytes,32,32,'jpg'),signal()),/mismatch/);await assert.rejects(prepareThumbnailImages(block(Buffer.from('<svg/>'),32,32),signal()),/signature/);
});
test('QOI conversion preserves pixel channels and rejects oversized, truncated or overrun streams',async()=>{
 const raw=Uint8Array.from({length:32*32*4},(_,i)=>i%256),encoded=Buffer.from(qoi.encode(raw,{width:32,height:32,channels:4,colorspace:0})),images=await prepareThumbnailImages(block(encoded,32,32,'qoi'),signal());assert.equal(images[0].format,'png');assert.deepEqual(await sharp(images[0].bytes).raw().toBuffer(),Buffer.from(raw));
 for(const mutated of [encoded.subarray(0,encoded.length-1),Buffer.concat([encoded.subarray(0,14),Buffer.from([253]),encoded.subarray(-8)])])await assert.rejects(prepareThumbnailImages(block(mutated,32,32,'qoi'),signal()),/QOI/);
 const oversized=Buffer.from(encoded);oversized.writeUInt32BE(100000,4);await assert.rejects(prepareThumbnailImages(block(oversized,32,32,'qoi'),signal()),/limit/);
});
