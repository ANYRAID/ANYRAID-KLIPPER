import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,open,rm,readdir,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PublishedPrintFiles,PublishedFileChangedError,PublishedFileMoveCommitError,type PublishedFileChange} from '../src/storage/published-files.ts';
const signal=()=>new AbortController().signal;
async function fixture(options:Parameters<typeof PublishedPrintFiles.open>[1]={}){
 const dir=await mkdtemp(join(tmpdir(),'published-move-')),root=join(dir,'files'),sourcePath=join(dir,'source');await writeFile(sourcePath,'G1 X1\n');const source=await open(sourcePath,'r');let store=await PublishedPrintFiles.open(root,options);
 return {dir,root,source,get store(){return store;},async reopen(){await store.close();store=await PublishedPrintFiles.open(root,options);},async close(){await store.close();await source.close();await rm(dir,{recursive:true,force:true});}};
}
test('single receipt rename preserves content, print identity, sealed readers and recovered namespace',async()=>{
 const f=await fixture(),events:PublishedFileChange[]=[];let reader:Awaited<ReturnType<PublishedPrintFiles['acquire']>>|undefined;
 try{
  const before=await f.store.publish('job','original.gcode',f.source,signal());await f.store.mutateDirectory('零件',false,signal());f.store.observeChanges(event=>events.push(event));reader=await f.store.acquire('job',signal());
  const plan=await f.store.prepareFileMove('job.gcode','零件/50% 模型.gcode',signal());assert(Object.isFrozen(plan));assert(Object.isFrozen(plan.after));const result=await f.store.moveFile(plan,signal());
  assert.equal(result.after.id,before.id);assert.equal(result.after.sha256,before.sha256);assert.equal(result.after.size,before.size);assert.equal(result.after.name,'50% 模型.gcode');assert.equal(await f.store.resolvePath('零件/50% 模型.gcode',signal()),'job');await assert.rejects(f.store.resolvePath('job.gcode',signal()),{code:'ENOENT'});
  assert.equal(events.length,1);assert.equal(events[0].action,'move_file');assert.deepEqual(events[0].sourceFile,before);assert.deepEqual(events[0].file,result.after);
  assert.equal(await readFile(join(f.root,before.sha256+'.gcode'),'utf8'),'G1 X1\n');await f.reopen();assert.deepEqual((await f.store.describe('job',signal())).file,result.after);assert.equal(f.store.status.storedBytes,(await Promise.all((await readdir(f.root)).map(async name=>(await (await import('node:fs/promises')).stat(join(f.root,name))).size))).reduce((a,b)=>a+b,0));
  const batch=(await reader.next(signal()))!;assert.equal(batch.script,'G1 X1');reader.commit(batch);assert.equal(await reader.next(signal()),null);
 }finally{await reader?.close();await f.close();}
});
test('move to directory and root resolves basename; same-name move has no physical rewrite',async()=>{
 const f=await fixture();try{
  await f.store.mutateDirectory('parts',false,signal());await f.store.publish('job','job.gcode',f.source,signal(),'start.gcode');
  await f.store.moveFile(await f.store.prepareFileMove('start.gcode','parts',signal()),signal());assert.equal(f.store.filename('job'),'parts/start.gcode');
  await f.store.moveFile(await f.store.prepareFileMove('parts/start.gcode','',signal()),signal());assert.equal(f.store.filename('job'),'start.gcode');
  const bytes=await readFile(join(f.root,'job.json')),identity=await f.store.describeSource('job',signal());await f.store.moveFile(await f.store.prepareFileMove('start.gcode','start.gcode',signal()),signal());assert.deepEqual(await readFile(join(f.root,'job.json')),bytes);assert.deepEqual(await f.store.describeSource('job',signal()),identity);
 }finally{await f.close();}
});
test('move rejects collisions, unsafe names, missing parents, directories and foreign or stale plans without losing files',async()=>{
 const f=await fixture(),other=await fixture();try{
  await f.store.publish('one','a.gcode',f.source,signal(),'a.gcode');await f.store.publish('two','b.gcode',f.source,signal(),'b.gcode');await f.store.mutateDirectory('parts',false,signal());
  for(const path of ['../x.gcode','/x.gcode','parts//x.gcode','parts\\x.gcode'])await assert.rejects(f.store.prepareFileMove('a.gcode',path,signal()));
  await assert.rejects(f.store.prepareFileMove('a.gcode','b.gcode',signal()),{code:'EEXIST'});await assert.rejects(f.store.prepareFileMove('a.gcode','missing/x.gcode',signal()),{code:'ENOENT'});await assert.rejects(f.store.prepareFileMove('parts','renamed',signal()),{code:'ENOTSUP'});
  const stale=await f.store.prepareFileMove('a.gcode','x.gcode',signal());await assert.rejects(other.store.moveFile(stale,signal()),/another store/);await f.store.moveFile(await f.store.prepareFileMove('a.gcode','y.gcode',signal()),signal());await assert.rejects(f.store.moveFile(stale,signal()),PublishedFileChangedError);
  const plan=await f.store.prepareFileMove('y.gcode','x.gcode',signal());await f.store.publish('three','x.gcode',f.source,signal(),'x.gcode');await assert.rejects(f.store.moveFile(plan,signal()),{code:'EEXIST'});assert.equal(f.store.filename('one'),'y.gcode');assert.equal(f.store.status.reservedBytes,0);
 }finally{await f.close();await other.close();}
});
test('cancellation before replacement preserves source; after replacement finishes durable move',async t=>{
 const f=await fixture(),controller=new AbortController();try{
  await f.store.publish('job','a',f.source,signal(),'a.gcode');const plan=await f.store.prepareFileMove('a.gcode','b.gcode',signal());controller.abort(new Error('cancel before move'));await assert.rejects(f.store.moveFile(plan,controller.signal),/cancel before move/);assert.equal(f.store.filename('job'),'a.gcode');
  const after=new AbortController(),prototype=Object.getPrototypeOf(f.source),original=prototype.sync;const injected=t.mock.method(prototype,'sync',async function(this:import('node:fs/promises').FileHandle){if((await this.stat()).isDirectory())after.abort(new Error('cancel after replace'));return original.call(this);});
  try{await f.store.moveFile(plan,after.signal);assert(after.signal.aborted);assert.equal(f.store.filename('job'),'b.gcode');}finally{injected.mock.restore();}
  await f.reopen();assert.equal(await f.store.resolvePath('b.gcode',signal()),'job');assert.equal(f.store.status.reservedBytes,0);
 }finally{await f.close();}
});
test('post-replacement sync failure fences acquisition and notifications; reopening recovers new identity',async t=>{
 const f=await fixture(),events:PublishedFileChange[]=[];try{
  const before=await f.store.publish('job','a',f.source,signal(),'a.gcode');f.store.observeChanges(e=>events.push(e));const plan=await f.store.prepareFileMove('a.gcode','b.gcode',signal()),prototype=Object.getPrototypeOf(f.source),original=prototype.sync;
  const injected=t.mock.method(prototype,'sync',async function(this:import('node:fs/promises').FileHandle){if((await this.stat()).isDirectory())throw new Error('move directory sync failure');return original.call(this);});
  try{await assert.rejects(f.store.moveFile(plan,signal()),e=>e instanceof PublishedFileMoveCommitError&&e.phase==='replaced');assert(f.store.status.writeFault);assert.equal(events.length,0);await assert.rejects(f.store.acquire('job',signal()),/require recovery/);await assert.rejects(f.store.inspect('job'),/require recovery/);}finally{injected.mock.restore();}
  await f.reopen();assert.equal(f.store.filename('job'),'b.gcode');assert.equal((await f.store.inspect('job')).sha256,before.sha256);assert.equal(f.store.status.reservedBytes,0);assert.equal((await readdir(f.root)).some(name=>name.startsWith('.receipt-')),false);
 }finally{await f.close();}
});
test('pre-replacement write failure cleans its own temporary receipt and recovers original namespace',async t=>{
 const f=await fixture();try{
  await f.store.publish('job','a',f.source,signal(),'a.gcode');const plan=await f.store.prepareFileMove('a.gcode','b.gcode',signal()),prototype=Object.getPrototypeOf(f.source),original=prototype.sync;
  const injected=t.mock.method(prototype,'sync',async function(this:import('node:fs/promises').FileHandle){if(!(await this.stat()).isDirectory())throw new Error('staged receipt sync failure');return original.call(this);});
  try{await assert.rejects(f.store.moveFile(plan,signal()),e=>e instanceof PublishedFileMoveCommitError&&e.phase==='before-replace');assert.equal(f.store.status.writeFault,undefined);assert.equal(f.store.filename('job'),'a.gcode');assert.equal(f.store.status.reservedBytes,0);}finally{injected.mock.restore();}
  await f.reopen();assert.equal(await f.store.resolvePath('a.gcode',signal()),'job');assert.equal((await readdir(f.root)).some(name=>name.startsWith('.receipt-')),false);
 }finally{await f.close();}
});
test('external receipt edits and temporary-byte quota reject moves before replacement',async()=>{
 const f=await fixture();try{
  const before=await f.store.publish('job','a',f.source,signal(),'a.gcode'),plan=await f.store.prepareFileMove('a.gcode','b.gcode',signal());await chmod(join(f.root,'job.json'),0o600);await writeFile(join(f.root,'job.json'),JSON.stringify({...before,name:'outside.gcode'}));await assert.rejects(f.store.moveFile(plan,signal()),PublishedFileChangedError);assert.equal(f.store.filename('job'),'a.gcode');
 }finally{await f.close();}
 const limited=await fixture({maxStorageBytes:2200});try{
  await limited.store.publish('job','a',limited.source,signal(),'a.gcode');await limited.store.publish('second','b',limited.source,signal(),'b.gcode');await limited.store.close();const charged=(await (await import('node:fs/promises')).stat(join(limited.root,'job.json'))).size+(await (await import('node:fs/promises')).stat(join(limited.root,'second.json'))).size+6;
  const store=await PublishedPrintFiles.open(limited.root,{maxStorageBytes:charged});try{const plan=await store.prepareFileMove('a.gcode','c.gcode',signal());await assert.rejects(store.moveFile(plan,signal()),/quota/);assert.equal(store.filename('job'),'a.gcode');assert.equal(store.status.reservedBytes,0);}finally{await store.close();}
 }finally{await limited.close();}
});
