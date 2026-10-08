import test from 'node:test';
import assert from 'node:assert/strict';
import {open,mkdtemp,writeFile,readFile,readlink,readdir,rm,chmod,access,type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
const signal=new AbortController().signal;
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'published-retirement-')),root=join(dir,'files');await writeFile(join(dir,'source'),'G1 X1\n');const source=await open(join(dir,'source'),'r');let store=await PublishedPrintFiles.open(root);return {dir,root,source,get store(){return store;},async publish(id:string){return store.publish(id,id+'.gcode',source,signal);},async reopen(){await store.close();store=await PublishedPrintFiles.open(root);},async close(){await store.close();await source.close();await rm(dir,{recursive:true,force:true});}};}
test('retirement preserves shared content, independent readers and exact storage accounting',async()=>{
 const f=await fixture();try{const a=await f.publish('a'),b=await f.publish('b'),c=await f.publish('c'),reader=await f.store.acquire('a',signal);try{assert.deepEqual(await f.store.removeMany(['a','b'],signal),[a,b]);assert.equal(f.store.status.publishedFiles,1);assert.equal(f.store.status.storedBytes,c.size+Buffer.byteLength(JSON.stringify(c)));assert.deepEqual((await f.store.readBytes('c',signal)).bytes,Buffer.from('G1 X1\n'));assert.deepEqual(await f.store.removeMany(['c'],signal),[c]);assert.equal(f.store.status.storedBytes,0);assert.deepEqual(await readdir(f.root),[]);const batch=(await reader.next(signal))!;assert.equal(batch.script,'G1 X1');reader.commit(batch);}finally{await reader.close();}await f.reopen();assert.deepEqual(await f.store.listIds(signal),[]);}finally{await f.close();}
});
for(const held of [1,2])test(`retirement joins directory barrier ${held} and drains late cancellation`,{timeout:15000},async t=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>(),abort=new AbortController();let roots=0,events=0,settled=false,closed=false;
 try{const a=await f.publish('a');await writeFile(join(f.dir,'source'),'G1 X2\n');const b=await f.publish('b'),prototype=Object.getPrototypeOf(f.source) as FileHandle,original=prototype.sync;f.store.observeChanges(()=>events++);
  t.mock.method(prototype,'sync',async function(this:FileHandle){if(await readlink('/proc/self/fd/'+this.fd)===f.root&&++roots===held){entered.resolve();await resume.promise;}return original.call(this);});
  const ids=['a','b'],task=f.store.removeMany(ids,abort.signal);ids[0]='outside';void task.then(()=>{settled=true;},()=>{settled=true;});await entered.promise;assert.equal(settled,false);assert.equal(events,0);await assert.rejects(access(join(f.root,'a.json')),{code:'ENOENT'});await assert.rejects(access(join(f.root,'b.json')),{code:'ENOENT'});
  for(const record of [a,b])if(held===1)await access(join(f.root,record.sha256+'.gcode'));else await assert.rejects(access(join(f.root,record.sha256+'.gcode')),{code:'ENOENT'});
  const closing=f.store.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);abort.abort(new Error('late cancellation'));resume.resolve();assert.deepEqual(await task,[a,b]);assert.equal(roots,2);assert.equal(events,2);assert.equal(settled,true);await closing;assert.equal(closed,true);t.mock.restoreAll();await f.reopen();assert.deepEqual(await readdir(f.root),[]);
 }finally{resume.resolve();t.mock.restoreAll();await f.close();}
});
for(const phase of ['second-receipt','second-content'] as const)test(`partial ${phase} unlink failure requires recovery without rollback`,async t=>{
 const f=await fixture(),fs=createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises'),original=fs.unlink,failure=Object.assign(new Error('partial unlink failed'),{code:'EIO'});let events=0;
 try{const a=await f.publish('a');await writeFile(join(f.dir,'source'),'G1 X2\n');const b=await f.publish('b');await writeFile(join(f.dir,'source'),'G1 X3\n');const current=await f.publish('current'),target=phase==='second-receipt'?'b.json':b.sha256+'.gcode';f.store.observeChanges(()=>events++);
  t.mock.method(fs,'unlink',async function(path:Parameters<typeof fs.unlink>[0]){if(String(path).endsWith('/'+target))throw failure;return original(path);});syncBuiltinESMExports();
  await assert.rejects(f.store.removeMany(['a','b'],signal),error=>error===failure);assert.equal(f.store.status.writeFault,failure);assert.equal(events,0);await assert.rejects(access(join(f.root,'a.json')),{code:'ENOENT'});if(phase==='second-receipt')await access(join(f.root,'b.json'));else{await assert.rejects(access(join(f.root,'b.json')),{code:'ENOENT'});await assert.rejects(access(join(f.root,a.sha256+'.gcode')),{code:'ENOENT'});}
  t.mock.restoreAll();syncBuiltinESMExports();await f.reopen();assert.deepEqual(await f.store.listIds(signal),phase==='second-receipt'?['b','current']:['current']);assert.deepEqual(await f.store.inspect('current'),current);assert.deepEqual((await f.store.readBytes('current',signal)).bytes,Buffer.from('G1 X3\n'));if(phase==='second-receipt')assert.deepEqual((await f.store.readBytes('b',signal)).bytes,Buffer.from('G1 X2\n'));
 }finally{t.mock.restoreAll();syncBuiltinESMExports();await f.close();}
});
test('invalid batches, missing members and preabort leave every receipt intact',async()=>{
 const f=await fixture();try{const a=await f.publish('a'),b=await f.publish('b');for(const ids of [[],['a','a'],Array.from({length:17},(_,i)=>String(i)),['a','missing'],['a','../escape']])await assert.rejects(f.store.removeMany(ids,signal));await assert.rejects(f.store.removeMany(['a','b'],AbortSignal.abort(new Error('preabort'))),/preabort/);assert.deepEqual(await f.store.inspect('a'),a);assert.deepEqual(await f.store.inspect('b'),b);assert.equal(f.store.status.writeFault,undefined);assert.equal(f.store.status.publishedFiles,2);}finally{await f.close();}
});
test('all receipts are revalidated before the first unlink',async()=>{
 const f=await fixture();try{const a=await f.publish('a'),b=await f.publish('b'),path=join(f.root,'b.json'),bytes=await readFile(path);await chmod(path,0o600);await writeFile(path,JSON.stringify({...b,name:'changed.gcode'}));await assert.rejects(f.store.removeMany(['a','b'],signal),/changed/);assert.deepEqual(await f.store.inspect('a'),a);assert.equal(f.store.status.writeFault,undefined);await writeFile(path,bytes);await chmod(path,0o400);await f.store.removeMany(['a','b'],signal);}finally{await f.close();}
});
test('preview receipts are rejected before unpreviewed members are changed',async()=>{
 const f=await fixture();let image:FileHandle|undefined;try{const a=await f.publish('a');await writeFile(join(f.dir,'image'),Buffer.from('89504e470d0a1a0a','hex'));image=await open(join(f.dir,'image'),'r');const b=await f.store.publish('b','b.gcode',f.source,signal,undefined,image);await assert.rejects(f.store.removeMany(['a','b'],signal),/previews/);assert.deepEqual(await f.store.inspect('a'),a);assert.deepEqual(await f.store.inspect('b'),b);assert.equal(f.store.status.writeFault,undefined);}finally{await image?.close();await f.close();}
});
for(const failed of [1,2])test(`directory barrier ${failed} failure fences writes and recovers the remaining head`,async t=>{
 const f=await fixture(),failure=Object.assign(new Error('retirement sync failed'),{code:failed===1?'EIO':'ENOSPC'});let roots=0;
 try{await f.publish('a');await writeFile(join(f.dir,'source'),'G1 X2\n');await f.publish('b');await writeFile(join(f.dir,'source'),'G1 X3\n');const current=await f.publish('current'),prototype=Object.getPrototypeOf(f.source) as FileHandle,original=prototype.sync;
  t.mock.method(prototype,'sync',async function(this:FileHandle){if(await readlink('/proc/self/fd/'+this.fd)===f.root&&++roots===failed)throw failure;return original.call(this);});await assert.rejects(f.store.removeMany(['a','b'],signal),error=>error===failure);assert.equal(f.store.status.writeFault,failure);await assert.rejects(f.publish('next'),/recovery/);t.mock.restoreAll();await f.reopen();assert.deepEqual(await f.store.listIds(signal),['current']);assert.deepEqual(await f.store.inspect('current'),current);assert.deepEqual((await f.store.readBytes('current',signal)).bytes,Buffer.from('G1 X3\n'));assert.equal(f.store.status.storedBytes,current.size+Buffer.byteLength(JSON.stringify(current)));
 }finally{t.mock.restoreAll();await f.close();}
});
