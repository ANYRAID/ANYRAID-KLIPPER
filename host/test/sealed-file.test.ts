import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm,readdir} from 'node:fs/promises';
import {closeSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createSealedPrintReader} from '../src/gcode/sealed-file.ts';
const native=createRequire(import.meta.url)(process.env.ANYRAID_SEALED_FILE_ADDON??'../build/sealed-file.node') as {create():number;seal(fd:number):void;lockDirectory(fd:number):void};
const sha=(text:string)=>createHash('sha256').update(text).digest('hex'),signal=()=>new AbortController().signal;
async function fixture(text='G1 X1\n'){
 const directory=await mkdtemp(join(tmpdir(),'sealed-print-')),path=join(directory,'file');await writeFile(path,text);const file=await open(path,'r');
 return {file,path,async close(){await file.close();await rm(directory,{recursive:true,force:true});}};
}
test('Linux seals prevent writes and size changes through every descriptor',async()=>{
 const fd=native.create(),file=await open(`/proc/self/fd/${fd}`,'r+');closeSync(fd);
 try{await file.write('G1 X1\n');native.seal(file.fd);native.seal(file.fd);const second=await open(`/proc/self/fd/${file.fd}`,'r+');try{for(const operation of [()=>second.write('G1 X9\n',0),()=>second.truncate(0),()=>second.truncate(100)])await assert.rejects(operation(),{code:'EPERM'});assert.equal((await second.readFile()).toString(),'G1 X1\n');}finally{await second.close();}}finally{await file.close();}
});
test('source replacement and in-place edits cannot change a sealed print reader',async()=>{
 const text='G1 X1\nG1 X2\n',f=await fixture(text);try{const snapshot=await createSealedPrintReader(f.file,sha(text),signal());try{await writeFile(f.path,'G1 X9\n');const batch=(await snapshot.reader.next(signal()))!;assert.equal(batch.script,'G1 X1\nG1 X2');snapshot.reader.commit(batch);assert.equal(await snapshot.reader.next(signal()),null);assert.equal(snapshot.size,Buffer.byteLength(text));assert.equal(snapshot.sha256,sha(text));}finally{await snapshot.reader.close();}}finally{await f.close();}
});
test('mismatched published digest, limits and pre-cancellation produce no usable snapshot',async()=>{
 const f=await fixture();try{await assert.rejects(createSealedPrintReader(f.file,sha('different'),signal()),/digest/);await assert.rejects(createSealedPrintReader(f.file,sha('G1 X1\n'),signal(),{maxBytes:2}),/exceeds/);const controller=new AbortController();controller.abort();await assert.rejects(createSealedPrintReader(f.file,sha('G1 X1\n'),controller.signal));assert.equal((await f.file.stat()).size,6);}finally{await f.close();}
});
test('empty files seal normally and repeated failed snapshots do not leak descriptors',async()=>{
 const f=await fixture('');try{const before=(await readdir('/proc/self/fd')).length;for(let i=0;i<30;i++)await assert.rejects(createSealedPrintReader(f.file,sha('not empty'),signal()));const snapshot=await createSealedPrintReader(f.file,sha(''),signal());assert.equal(await snapshot.reader.next(signal()),null);await snapshot.reader.close();assert.equal((await readdir('/proc/self/fd')).length,before);}finally{await f.close();}
});
test('native sealing rejects invalid descriptors and ordinary disk files',async()=>{
 for(const fd of [-1,1.5,NaN,Infinity])assert.throws(()=>native.seal(fd),/descriptor/);const f=await fixture();try{assert.throws(()=>native.seal(f.file.fd),/print file seals|Seal print file/);}finally{await f.close();}
});
test('native directory locking rejects invalid descriptors and ordinary files',async()=>{
 for(const fd of [-1,1.5,NaN,Infinity,2**32])assert.throws(()=>native.lockDirectory(fd),/descriptor/);
 const f=await fixture();try{assert.throws(()=>native.lockDirectory(f.file.fd),/requires directory/);}finally{await f.close();}
});

test('cancellation and mutation during copy close the private snapshot',async()=>{
 const text='G1 X1\n'.repeat(20000),f=await fixture(text);
 try{for(const mutation of [false,true]){await writeFile(f.path,text);const controller=new AbortController(),before=(await readdir('/proc/self/fd')).length;let first=true;
  const source={stat:()=>f.file.stat({bigint:true}),read:async(buffer:Buffer,offset:number,length:number,position:number)=>{const result=await f.file.read(buffer,offset,length,position);if(first){first=false;if(mutation)await writeFile(f.path,text.replace('X1','X9'));else controller.abort(new Error('copy cancelled'));}return result;}} as unknown as import('node:fs/promises').FileHandle;
  await assert.rejects(createSealedPrintReader(source,sha(text),controller.signal),mutation?/changed/:/cancelled/);assert.equal((await readdir('/proc/self/fd')).length,before);
 }}finally{await f.close();}
});
