import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm,readdir,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {PrintSnapshotBudget} from '../src/gcode/snapshot-budget.ts';
const signal=()=>new AbortController().signal;
async function fixture(options:Parameters<typeof PublishedPrintFiles.open>[1]={}){
 const directory=await mkdtemp(join(tmpdir(),'published-delete-')),root=join(directory,'store'),path=join(directory,'source');
 await writeFile(path,'G1 X1\n');const source=await open(path,'r'),store=await PublishedPrintFiles.open(root,options);
 return {root,source,store,async close(){await store.close();await source.close();await rm(directory,{recursive:true,force:true});}};
}
function blockedSource(file:import('node:fs/promises').FileHandle){
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const source={stat:()=>file.stat({bigint:true}),read:async(buffer:Buffer,offset:number,length:number,position:number)=>{entered.resolve();await release.promise;return file.read(buffer,offset,length,position);}} as unknown as import('node:fs/promises').FileHandle;
 return {entered,release,source};
}
test('deleting the last reference releases bytes and a publication slot durably',async()=>{
 const f=await fixture({maxPublishedFiles:1,maxStorageBytes:2500});
 try{
  const record=await f.store.publish('one','file',f.source,signal());
  assert.deepEqual(await f.store.remove('one',signal()),record);
  assert.equal(f.store.status.storedBytes,0);assert.equal(f.store.status.publishedFiles,0);
  assert.deepEqual(await readdir(f.root),[]);
  await assert.rejects(f.store.acquire('one',signal()),{code:'ENOENT'});
  await assert.rejects(f.store.remove('one',signal()),{code:'ENOENT'});
  await f.store.publish('two','file',f.source,signal());await f.store.close();
  const reopened=await PublishedPrintFiles.open(f.root,{maxPublishedFiles:1,maxStorageBytes:2500});
  try{assert.equal(reopened.status.publishedFiles,1);assert.equal((await reopened.inspect('two')).sha256,record.sha256);}finally{await reopened.close();}
 }finally{await f.close();}
});
test('recovered shared content survives until its last receipt; sealed readers survive deletion',async()=>{
 const f=await fixture();
 try{
  const one=await f.store.publish('one','file',f.source,signal()),two=await f.store.publish('two','file',f.source,signal());
  await f.store.close();const store=await PublishedPrintFiles.open(f.root);
  try{
   const initial=store.status.storedBytes;await store.remove('one',signal());
   assert.equal(store.status.storedBytes,initial-Buffer.byteLength(JSON.stringify(one)));
   assert.deepEqual((await readdir(f.root)).sort(),[two.sha256+'.gcode','two.json'].sort());
   const reader=await store.acquire('two',signal());
   try{
    await store.remove('two',signal());assert.equal(store.status.storedBytes,0);
    await store.close();const batch=(await reader.next(signal()))!;
    assert.equal(batch.script,'G1 X1');reader.commit(batch);assert.equal(await reader.next(signal()),null);
   }finally{await reader.close();}
  }finally{await store.close();}
 }finally{await f.close();}
});
test('delete waits for a snapshot already being prepared before reclaiming content',async()=>{
 const entered=Promise.withResolvers<void>();
 class ObservedBudget extends PrintSnapshotBudget {override reserve(bytes:number){const value=super.reserve(bytes);entered.resolve();return value;}}
 const f=await fixture({budget:new ObservedBudget()});
 try{
  await f.store.publish('one','file',f.source,signal());const acquiring=f.store.acquire('one',signal());
  await entered.promise;const deleting=f.store.remove('one',signal());
  const reader=await acquiring;
  try{await deleting;assert.deepEqual(await readdir(f.root),[]);const batch=(await reader.next(signal()))!;assert.equal(batch.script,'G1 X1');reader.commit(batch);}finally{await reader.close();}
 }finally{await f.close();}
});
test('delete waits for concurrent deduplicated publication and keeps its new reference',async()=>{
 const f=await fixture(),blocked=blockedSource(f.source);
 try{
  const record=await f.store.publish('one','file',f.source,signal());
  const publishing=f.store.publish('two','file',blocked.source,signal());await blocked.entered.promise;
  let deleted=false;const deleting=f.store.remove('one',signal()).then(()=>{deleted=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(deleted,false);
  blocked.release.resolve();await publishing;await deleting;
  assert.equal((await f.store.inspect('two')).sha256,record.sha256);
  const reader=await f.store.acquire('two',signal());await reader.close();
  assert.equal(f.store.status.storedBytes,record.size+Buffer.byteLength(JSON.stringify({...record,id:'two'})));
 }finally{blocked.release.resolve();await f.close();}
});
test('queued delete cancellation is prompt and lets waiting reads proceed',async()=>{
 const f=await fixture(),blocked=blockedSource(f.source),controller=new AbortController();
 try{
  await f.store.publish('one','file',f.source,signal());
  const publishing=f.store.publish('two','file',blocked.source,signal());await blocked.entered.promise;
  const deletion=f.store.remove('one',controller.signal),rejected=assert.rejects(deletion,/cancel deletion/);
  const inspecting=f.store.inspect('one');controller.abort(new Error('cancel deletion'));await rejected;
  assert.equal((await inspecting).id,'one');assert.equal(f.store.status.pendingOperations,1);
  blocked.release.resolve();await publishing;assert.equal(f.store.status.publishedFiles,2);
 }finally{blocked.release.resolve();await f.close();}
});
test('close drains accepted deletion and bounds queued admissions',async()=>{
 const f=await fixture({maxOperations:2}),blocked=blockedSource(f.source);
 try{
  await f.store.publish('one','file',f.source,signal());
  const publishing=f.store.publish('two','file',blocked.source,signal());await blocked.entered.promise;
  const deleting=f.store.remove('one',signal());await assert.rejects(f.store.inspect('one'),/limit/);
  const closing=f.store.close();await assert.rejects(f.store.remove('two',signal()),/closed/);
  blocked.release.resolve();await publishing;await deleting;await closing;
  const reopened=await PublishedPrintFiles.open(f.root);
  try{assert.equal(reopened.status.publishedFiles,1);assert.equal((await reopened.inspect('two')).id,'two');}finally{await reopened.close();}
 }finally{blocked.release.resolve();await f.close();}
});
test('content reclamation failure fences further writes and retains uncertain byte charge',async()=>{
 const f=await fixture();
 try{
  const record=await f.store.publish('one','file',f.source,signal()),blob=join(f.root,record.sha256+'.gcode');
  // Inject an unlink failure without changing process-wide filesystem functions.
  await rm(blob);await mkdir(blob);
  await assert.rejects(f.store.remove('one',signal()),{code:'EISDIR'});
  assert.ok(f.store.status.writeFault);assert.equal(f.store.status.storedBytes,record.size);
  assert.equal(f.store.status.publishedFiles,0);assert.equal(f.store.status.reservedBytes,0);
  await assert.rejects(f.store.publish('two','file',f.source,signal()),/require recovery/);
  await assert.rejects(f.store.remove('one',signal()),/require recovery/);
  await f.store.close();await rm(blob,{recursive:true});const recovered=await PublishedPrintFiles.open(f.root);
  try{assert.equal(recovered.status.storedBytes,0);await recovered.publish('two','file',f.source,signal());}finally{await recovered.close();}
 }finally{await f.close();}
});
test('receipt fsync failure keeps content and quota until restart recovery',async t=>{
 const f=await fixture();
 try{
  const record=await f.store.publish('one','file',f.source,signal()),charged=f.store.status.storedBytes;
  const prototype=Object.getPrototypeOf(f.source) as import('node:fs/promises').FileHandle;
  const original=prototype.sync;
  const injected=t.mock.method(prototype,'sync',async function(this:import('node:fs/promises').FileHandle){
   if((await this.stat()).isDirectory())throw new Error('receipt sync failure');
   return original.call(this);
  });
  try{
   await assert.rejects(f.store.remove('one',signal()),/receipt sync failure/);
   assert.deepEqual(await readdir(f.root),[record.sha256+'.gcode']);
   assert.equal(f.store.status.storedBytes,charged);assert.equal(f.store.status.publishedFiles,0);
   await assert.rejects(f.store.publish('two','file',f.source,signal()),/require recovery/);
  }finally{injected.mock.restore();}
  await f.store.close();const recovered=await PublishedPrintFiles.open(f.root);
  try{assert.deepEqual(await readdir(f.root),[]);assert.equal(recovered.status.storedBytes,0);}finally{await recovered.close();}
 }finally{await f.close();}
});
test('after receipt unlink cancellation still completes ordered directory durability',async t=>{
 const f=await fixture(),controller=new AbortController();
 try{
  const record=await f.store.publish('one','file',f.source,signal());
  const aborted=new AbortController();aborted.abort(new Error('before deletion'));
  await assert.rejects(f.store.remove('one',aborted.signal),/before deletion/);
  assert.deepEqual(await f.store.inspect('one'),record);
  const prototype=Object.getPrototypeOf(f.source) as import('node:fs/promises').FileHandle,original=prototype.sync;
  let syncs=0;
  const injected=t.mock.method(prototype,'sync',async function(this:import('node:fs/promises').FileHandle){
   if((await this.stat()).isDirectory()){
    syncs++;const names=await readdir(f.root);
    assert.deepEqual(names,syncs===1?[record.sha256+'.gcode']:[]);
    controller.abort(new Error('after deletion boundary'));
   }
   return original.call(this);
  });
  try{assert.deepEqual(await f.store.remove('one',controller.signal),record);assert.equal(syncs,2);assert.equal(f.store.status.storedBytes,0);}finally{injected.mock.restore();}
 }finally{await f.close();}
});
