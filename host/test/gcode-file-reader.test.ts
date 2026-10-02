import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
const signal=()=>new AbortController().signal;
async function fixture(data:string|Buffer,options:Parameters<typeof GCodeFileReader.adopt>[1]={}){
 const directory=await mkdtemp(join(tmpdir(),'gcode-file-')),path=join(directory,'job.gcode');await writeFile(path,data);const file=await open(path,'r');
 try{const reader=await GCodeFileReader.adopt(file,options);return {reader,path,async close(){await reader.close();await rm(directory,{recursive:true,force:true});}};}catch(error){await file.close();await rm(directory,{recursive:true,force:true});throw error;}
}
test('UTF-8 and CRLF boundaries preserve exact committed byte offsets',async()=>{
 const f=await fixture('M117 中文\r\nG1 X1\n',{chunkBytes:1,batchLines:1});try{
  const first=await f.reader.next(signal());assert.equal(first!.script,'M117 中文');assert.equal(first!.endOffset,Buffer.byteLength('M117 中文\r\n'));assert.equal(f.reader.status.position,0);assert.equal(f.reader.status.eof,false);
  await assert.rejects(f.reader.next(signal()),/outstanding/);assert.throws(()=>f.reader.commit({...first!}),/commit/);f.reader.commit(first!);
  const second=await f.reader.next(signal());assert.equal(second!.script,'G1 X1');f.reader.commit(second!);assert.equal(await f.reader.next(signal()),null);assert.equal(f.reader.status.position,f.reader.status.size);assert.equal(f.reader.status.eof,true);
 }finally{await f.close();}
});
test('invalid UTF-8, NUL, embedded CR, oversized or unterminated lines fail closed',async()=>{
 for(const data of [Buffer.from([0xff,10]),'G1\0 X1\n','G1\r X1\n','G1 X1',';'.repeat(65537)+'\n']){
  const f=await fixture(data);try{await assert.rejects(f.reader.next(signal()));assert.equal(f.reader.status.position,0);assert.ok(f.reader.status.fault);await assert.rejects(f.reader.next(signal()),/unavailable/);}finally{await f.close();}
 }
});
test('metadata changes before subsequent read prevent replay of modified file',async()=>{
 const f=await fixture('G1 X1\nG1 X2\n',{chunkBytes:6,batchLines:1});try{const batch=await f.reader.next(signal());f.reader.commit(batch!);await writeFile(f.path,'G1 X9\n');await assert.rejects(f.reader.next(signal()),/changed/);assert.equal(f.reader.status.position,6);}finally{await f.close();}
});
test('empty file requires explicit EOF observation and aborted calls do not consume bytes',async()=>{
 const f=await fixture('');try{assert.equal(f.reader.status.eof,false);const controller=new AbortController();controller.abort();await assert.rejects(f.reader.next(controller.signal));assert.equal(f.reader.status.fault,undefined);assert.equal(await f.reader.next(signal()),null);}finally{await f.close();}
});
test('batch capacity bounds admission without losing buffered lines',async()=>{
 const f=await fixture(Array.from({length:300},(_,i)=>`G1 X${i}\n`).join(''));try{let count=0;while(true){const batch=await f.reader.next(signal());if(!batch)break;assert.ok(batch.lines<=128);count+=batch.lines;f.reader.commit(batch);}assert.equal(count,300);assert.equal(f.reader.status.position,f.reader.status.size);}finally{await f.close();}
});
test('dispatch success is required before byte progress advances; script errors do not continue',async()=>{
 const {GCodeDispatch,GCodeError}=await import('../src/gcode/dispatch.ts');
 const f=await fixture('G1 X1\nG1 X2\n',{batchLines:1}),first=Promise.withResolvers<void>();let calls=0;
 const dispatch=new GCodeDispatch({output(){},shutdown(){}});dispatch.register('G1',async()=>{calls++;if(calls===1)await first.promise;else throw new GCodeError('move rejected');});dispatch.setReady(true);
 try{
  const batch=(await f.reader.next(signal()))!,executing=dispatch.execute(batch.script);assert.equal(f.reader.status.position,0);first.resolve();await executing;f.reader.commit(batch);assert.equal(f.reader.status.position,6);
  const rejected=(await f.reader.next(signal()))!;await assert.rejects(dispatch.execute(rejected.script),/move rejected/);assert.equal(f.reader.status.position,6);assert.equal(f.reader.status.eof,false);assert.equal(calls,2);
 }finally{await f.close();}
});

test('concurrent close callers share descriptor completion and invalidate pending batches',async()=>{
 const f=await fixture('G1 X1\n');try{const batch=(await f.reader.next(signal()))!,closing=f.reader.close();assert.equal(closing,f.reader.close());assert.throws(()=>f.reader.commit(batch));await closing;await assert.rejects(f.reader.next(signal()),/unavailable/);}finally{await f.close();}
});
