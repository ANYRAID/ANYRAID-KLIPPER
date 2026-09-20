import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm,utimes} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {decodeMetadataUtf8,readMetadataWindow,METADATA_READ_BYTES as R} from '../src/moonraker/metadata-window.ts';
const signal=()=>new AbortController().signal;
async function fixture(data:string|Buffer){const directory=await mkdtemp(join(tmpdir(),'metadata-window-')),path=join(directory,'file');await writeFile(path,data);const file=await open(path,'r');return {path,file,async close(){await file.close();await rm(directory,{recursive:true,force:true});}};}
test('UTF-8 ignore matches Python for every two-byte input and preserves real replacements and BOM',()=>{
 const hash=createHash('sha256');for(let a=0;a<256;a++)for(let b=0;b<256;b++){hash.update(decodeMetadataUtf8(Buffer.from([a,b])));hash.update('\0');}
 const boundaries='\u0080\u07ff\u0800\ud7ff\ue000\u{10000}\u{10ffff}';assert.equal(decodeMetadataUtf8(Buffer.concat([Buffer.from(boundaries),Buffer.from([255])])),boundaries);
 assert.equal(hash.digest('hex'),'ccf4863824c605e0cc5b7fcac59f669beee1cf7d06173f9109cd77d2d89719bb');
 assert.equal(decodeMetadataUtf8(Buffer.concat([Buffer.from('\ufeff中😀�'),Buffer.from([0xed,0xa0,0x80,0xf4,0x90,0x80,0x80,0xe1,0x80,0x41,0xff])])),'\ufeff中😀�A');
});
test('metadata reads use positional IO without closing or advancing the caller descriptor',async()=>{
 const f=await fixture('ABCDE');try{await utimes(f.path,new Date(-12250),new Date(-12250));const byte=Buffer.alloc(1);await f.file.read(byte,0,1,null);assert.equal(byte.toString(),'A');const window=await readMetadataWindow(f.file,signal());assert.equal(window.data,'ABCDE');assert.equal(window.header,window.footer);assert.equal(window.modified,-12.25);await f.file.read(byte,0,1,null);assert.equal(byte.toString(),'B');assert.ok(Object.isFrozen(window.source));}finally{await f.close();}
});
test('byte windows cover short, intermediate and large files with no duplicate overlap',async()=>{
 for(const size of [0,R-1,R,R+1,2*R,2*R+100]){
  const text='H'.repeat(Math.min(R,size))+'M'.repeat(Math.max(0,size-2*R))+'T'.repeat(Math.max(0,Math.min(R,size-R))),f=await fixture(text);
  try{const window=await readMetadataWindow(f.file,signal());assert.equal(window.size,size);assert.equal(window.data,text.slice(0,R)+(size>R?text.slice(size>2*R?size-R:R):''));assert.equal(window.header,window.data.slice(0,R));assert.equal(window.footer,window.data.slice(-R));}finally{await f.close();}
 }
});
test('decoded window slicing uses codepoints and independently ignores split UTF-8 sequences',async()=>{
 for(const data of [Buffer.from('😀'+'H'.repeat(R-4)+'gap'+'T'.repeat(R)),Buffer.concat([Buffer.alloc(R-1,65),Buffer.from('中'),Buffer.alloc(32,66)])]){
  const f=await fixture(data);try{const window=await readMetadataWindow(f.file,signal()),head=decodeMetadataUtf8(data.subarray(0,R)),tail=decodeMetadataUtf8(data.subarray(data.length>2*R?data.length-R:R)),points=Array.from(head+tail);assert.equal(window.data,head+tail);assert.equal(window.header,points.slice(0,R).join(''));assert.equal(window.footer,points.slice(-R).join(''));}finally{await f.close();}
 }
});
test('short reads complete, while source changes and cancellation reject the window',async()=>{
 const f=await fixture('G1 X1\n');try{
  const short={stat:()=>f.file.stat({bigint:true}),read:(b:Buffer,o:number,n:number,p:number)=>f.file.read(b,o,Math.min(2,n),p)} as unknown as FileHandle;
  assert.equal((await readMetadataWindow(short,signal())).data,'G1 X1\n');
  for(const mutation of [false,true]){await writeFile(f.path,'G1 X1\n');const controller=new AbortController();
   const source={stat:()=>f.file.stat({bigint:true}),read:async(b:Buffer,o:number,n:number,p:number)=>{const value=await f.file.read(b,o,n,p);if(mutation)await writeFile(f.path,'changed');else controller.abort(new Error('read cancelled'));return value;}} as unknown as FileHandle;
   await assert.rejects(readMetadataWindow(source,controller.signal),mutation?/changed/:/cancelled/);
  }
  await assert.rejects(readMetadataWindow(f.file,signal(),{maxFileBytes:1}),/limit/);assert.ok((await f.file.stat()).isFile());
 }finally{await f.close();}
});
