import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,open,rm,readdir,stat,readlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PublishedPrintFiles,PublishedFileChangedError,PublishedNamespaceMoveCommitError,type PublishedDirectoryChange} from '../src/storage/published-files.ts';
import {validateMoveIntent,recoverMoveRecords} from '../src/storage/namespace-move.ts';
const signal=()=>new AbortController().signal;
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'published-dir-move-')),root=join(dir,'files'),sourcePath=join(dir,'source');await writeFile(sourcePath,'G1 X1\n');const source=await open(sourcePath,'r');let store=await PublishedPrintFiles.open(root);
 await store.mutateDirectory('parts',false,signal());await store.mutateDirectory('parts/sub',false,signal());
 for(const [id,path] of [['a','parts/a.gcode'],['b','parts/sub/b.gcode'],['other','outside.gcode']])await store.publish(id,id+'.gcode',source,signal(),path);
 return {dir,root,source,get store(){return store;},async reopen(){await store.close();store=await PublishedPrintFiles.open(root);},async close(){await store.close();await source.close();await rm(dir,{recursive:true,force:true});}};
}
test('nested directory move preserves all identities, sealed content, timestamps and one durable notification',async()=>{
 const f=await fixture(),events:PublishedDirectoryChange[]=[];const reader=await f.store.acquire('a',signal());try{
  const before=await f.store.catalog(signal());f.store.observeDirectories(event=>events.push(event));const plan=await f.store.prepareDirectoryMove('parts','renamed',signal());assert(Object.isFrozen(plan.changed));assert.equal(plan.changed.length,2);
  await f.store.moveDirectory(plan,signal());assert.equal(events.length,1);assert.equal(events[0].action,'move_dir');assert.equal(events[0].sourcePath,'parts');assert.equal(events[0].path,'renamed');assert.equal(await f.store.hasDirectory('parts',signal()),false);assert.equal(await f.store.hasDirectory('renamed/sub',signal()),true);
  assert.equal(await f.store.resolvePath('renamed/sub/b.gcode',signal()),'b');assert.equal(f.store.filename('other'),'outside.gcode');
  for(const entry of before){const current=await f.store.describe(entry.file.id,signal());assert.equal(current.file.sha256,entry.file.sha256);assert.equal(current.file.size,entry.file.size);assert(Math.abs(current.modified-entry.modified)<1e-6);}
  const batch=(await reader.next(signal()))!;assert.equal(batch.script,'G1 X1');reader.commit(batch);await f.reopen();assert.equal(await f.store.resolvePath('renamed/a.gcode',signal()),'a');
  const charged=(await Promise.all((await readdir(f.root)).map(async name=>(await stat(join(f.root,name))).size))).reduce((a,b)=>a+b,0);assert.equal(f.store.status.storedBytes,charged);assert.equal(f.store.status.reservedBytes,0);
 }finally{await reader.close();await f.close();}
});
test('directory targets resolve existing parents, reject self/descendants and retain empty directories',async()=>{
 const f=await fixture();try{
  for(const destination of ['parts','parts/sub','parts/sub/nested'])await assert.rejects(f.store.prepareDirectoryMove('parts',destination,signal()),{code:'EINVAL'});
  await f.store.mutateDirectory('target',false,signal());await f.store.moveDirectory(await f.store.prepareDirectoryMove('parts','target',signal()),signal());assert.equal(f.store.filename('b'),'target/parts/sub/b.gcode');
  await f.store.mutateDirectory('empty',false,signal());await f.store.moveDirectory(await f.store.prepareDirectoryMove('empty','target',signal()),signal());assert.equal(await f.store.hasDirectory('target/empty',signal()),true);
  await assert.rejects(f.store.prepareDirectoryMove('target/parts','outside.gcode',signal()),{code:'EEXIST'});await assert.rejects(f.store.prepareDirectoryMove('target/parts','missing/new',signal()),{code:'ENOENT'});
  await f.store.moveDirectory(await f.store.prepareDirectoryMove('target/parts','',signal()),signal());assert.equal(f.store.filename('b'),'parts/sub/b.gcode');
 }finally{await f.close();}
});
test('authorized directory membership and ownership cannot change while policy awaits',async()=>{
 const f=await fixture(),other=await fixture();try{
  const plan=await f.store.prepareDirectoryMove('parts','renamed',signal());await assert.rejects(other.store.moveDirectory(plan,signal()),/another store/);
  await f.store.publish('late','late',f.source,signal(),'parts/late.gcode');await assert.rejects(f.store.moveDirectory(plan,signal()),PublishedFileChangedError);assert.equal(f.store.filename('a'),'parts/a.gcode');assert.equal(f.store.filename('late'),'parts/late.gcode');
  const fresh=await f.store.prepareDirectoryMove('parts','renamed',signal());const abort=new AbortController();abort.abort(new Error('cancel before intent'));await assert.rejects(f.store.moveDirectory(fresh,abort.signal),/cancel before intent/);assert.equal(f.store.status.reservedBytes,0);assert(!(await readdir(f.root)).includes('.namespace-move.json'));
 }finally{await f.close();await other.close();}
});
for(const phase of ['before-intent','intent','partial-receipts','catalog','journal-removed'] as const)test('directory move failure recovers at '+phase,async t=>{
 const f=await fixture(),events:PublishedDirectoryChange[]=[];try{
  const plan=await f.store.prepareDirectoryMove('parts','renamed',signal());f.store.observeDirectories(e=>events.push(e));const prototype=Object.getPrototypeOf(f.source),original=prototype.sync;let roots=0,receipts=0;
  const injected=t.mock.method(prototype,'sync',async function(this:import('node:fs/promises').FileHandle){const path=await readlink('/proc/self/fd/'+this.fd),isRoot=(await this.stat()).isDirectory();if(isRoot)roots++;if(path.includes('/.receipt-'))receipts++;
   if(phase==='before-intent'&&path.includes('/.move-')||phase==='intent'&&isRoot&&roots===1||phase==='partial-receipts'&&receipts===2||phase==='catalog'&&isRoot&&roots===3||phase==='journal-removed'&&isRoot&&roots===4)throw new Error('injected '+phase);return original.call(this);
  });
  try{await assert.rejects(f.store.moveDirectory(plan,signal()),error=>error instanceof PublishedNamespaceMoveCommitError&&error.phase===(phase==='before-intent'?'before-intent':'intent-published'));assert.equal(events.length,0);assert.equal(f.store.status.reservedBytes,0);if(phase!=='before-intent'){assert(f.store.status.writeFault);await assert.rejects(f.store.acquire('a',signal()),/require recovery/);}}
  finally{injected.mock.restore();}
  if(phase==='partial-receipts'){assert.equal(JSON.parse(await readFile(join(f.root,'a.json'),'utf8')).path,'renamed/a.gcode');assert.equal(JSON.parse(await readFile(join(f.root,'b.json'),'utf8')).path,'parts/sub/b.gcode');}
  await f.reopen();assert.equal(f.store.filename('b'),phase==='before-intent'?'parts/sub/b.gcode':'renamed/sub/b.gcode');assert.equal((await readdir(f.root)).some(name=>name.startsWith('.receipt-')||name.startsWith('.move-')||name==='.namespace-move.json'),false);await f.reopen();assert.equal(f.store.filename('a'),phase==='before-intent'?'parts/a.gcode':'renamed/a.gcode');
 }finally{await f.close();}
});
test('cancellation after durable intent finishes the entire transaction',async t=>{
 const f=await fixture(),abort=new AbortController();try{
  const plan=await f.store.prepareDirectoryMove('parts','renamed',signal()),prototype=Object.getPrototypeOf(f.source),original=prototype.sync;let aborted=false;
  const injected=t.mock.method(prototype,'sync',async function(this:import('node:fs/promises').FileHandle){if(!aborted&&(await this.stat()).isDirectory()){aborted=true;abort.abort(new Error('cancel after decision'));}return original.call(this);});
  try{await f.store.moveDirectory(plan,abort.signal);}finally{injected.mock.restore();}assert(abort.signal.aborted);assert.equal(f.store.filename('a'),'renamed/a.gcode');assert.equal(f.store.filename('b'),'renamed/sub/b.gcode');await f.reopen();assert.equal(f.store.filename('b'),'renamed/sub/b.gcode');
 }finally{await f.close();}
});
test('intent validation is key-order independent and rejects forged transforms or omitted source children',async()=>{
 const f=await fixture();try{
  const plan=await f.store.prepareDirectoryMove('parts','renamed',signal()),reverse=(value:any):any=>Array.isArray(value)?value.map(reverse):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reverse(v)])):value;
  assert.deepEqual(validateMoveIntent(reverse(plan)),plan);assert.throws(()=>validateMoveIntent({...plan,changed:plan.changed.map(e=>({...e,after:{...e.after,sha256:'x'+e.after.sha256+'y'}}))}),/receipt/);
  const omitted=validateMoveIntent({...plan,changed:plan.changed.slice(0,1)});assert.throws(()=>recoverMoveRecords(omitted,[],new Map()),/source changed/);
  const files=(await f.store.catalog(signal())).map(e=>e.file);assert.throws(()=>recoverMoveRecords(omitted,files,new Map(plan.directoriesBefore.map(e=>[e.path,e.modified]))),/membership/);
  await f.store.close();await writeFile(join(f.root,'.namespace-move.json'),JSON.stringify(omitted),{mode:0o600});const garbage=join(f.root,'.receipt-11111111-1111-1111-1111-111111111111');await writeFile(garbage,'preserve');const before=await readFile(join(f.root,'a.json'));
  await assert.rejects(PublishedPrintFiles.open(f.root),/membership/);assert.deepEqual(await readFile(join(f.root,'a.json')),before);assert.equal(await readFile(garbage,'utf8'),'preserve');assert((await readdir(f.root)).includes('.namespace-move.json'));
 }finally{await f.close();}
});
test('directory move reserves complete journal and staging bytes before modifying any authority',async()=>{
 const f=await fixture();try{const charged=f.store.status.storedBytes;await f.store.close();const store=await PublishedPrintFiles.open(f.root,{maxStorageBytes:charged});try{await assert.rejects(store.moveDirectory(await store.prepareDirectoryMove('parts','renamed',signal()),signal()),/quota/);assert.equal(store.filename('a'),'parts/a.gcode');assert.equal(store.status.reservedBytes,0);assert(!(await readdir(f.root)).includes('.namespace-move.json'));}finally{await store.close();}}finally{await f.close();}
});
test('external directory index edits reject before intent and retain outside changes for recovery',async()=>{
 const f=await fixture();try{
  const plan=await f.store.prepareDirectoryMove('parts','renamed',signal()),path=join(f.root,'.directories.json');const index=JSON.parse(await readFile(path,'utf8'));index.directories.push({path:'outside',modified:1});await writeFile(path,JSON.stringify(index));
  await assert.rejects(f.store.moveDirectory(plan,signal()),error=>error instanceof PublishedNamespaceMoveCommitError&&error.phase==='before-intent'&&error.cause instanceof PublishedFileChangedError);assert.equal(f.store.filename('a'),'parts/a.gcode');assert(!(await readdir(f.root)).includes('.namespace-move.json'));await f.reopen();assert.equal(await f.store.hasDirectory('outside',signal()),true);
 }finally{await f.close();}
});
test('failed startup replay retains its intent and can resume again without moving unrelated content',async t=>{
 const f=await fixture();try{
  const plan=await f.store.prepareDirectoryMove('parts','renamed',signal());await f.store.close();await writeFile(join(f.root,'.namespace-move.json'),JSON.stringify(plan),{mode:0o600});const prototype=Object.getPrototypeOf(f.source),original=prototype.sync;let receipts=0;
  const injected=t.mock.method(prototype,'sync',async function(this:import('node:fs/promises').FileHandle){if((await readlink('/proc/self/fd/'+this.fd)).includes('/.receipt-')&&++receipts===2)throw new Error('startup replay interrupted');return original.call(this);});
  try{await assert.rejects(f.reopen(),/startup replay interrupted/);assert((await readdir(f.root)).includes('.namespace-move.json'));assert.equal(JSON.parse(await readFile(join(f.root,'a.json'),'utf8')).path,'renamed/a.gcode');assert.equal(JSON.parse(await readFile(join(f.root,'b.json'),'utf8')).path,'parts/sub/b.gcode');}finally{injected.mock.restore();}
  await f.reopen();assert.equal(f.store.filename('b'),'renamed/sub/b.gcode');assert.equal(f.store.filename('other'),'outside.gcode');assert(!(await readdir(f.root)).includes('.namespace-move.json'));
 }finally{await f.close();}
});
test('cached listing remains coherent and responsive while a directory decision is held, then changes atomically',async t=>{
 const f=await fixture(),held=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();try{
  const plan=await f.store.prepareDirectoryMove('parts','renamed',signal()),prototype=Object.getPrototypeOf(f.source),original=prototype.sync;let blocked=false;
  const injected=t.mock.method(prototype,'sync',async function(this:import('node:fs/promises').FileHandle){if(!blocked&&(await this.stat()).isDirectory()){blocked=true;entered.resolve();await held.promise;}return original.call(this);});
  try{const pending=f.store.moveDirectory(plan,signal());await entered.promise;const cached=await Promise.race([f.store.catalog(signal()),new Promise<never>((_resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Cached listing blocked on directory IO')),500);timer.unref();})]);assert.deepEqual(cached.map(e=>e.file.path),['parts/a.gcode','parts/sub/b.gcode','outside.gcode']);assert.equal((await f.store.directoryCatalog('',signal())).directories[0].path,'parts');held.resolve();await pending;assert.deepEqual((await f.store.catalog(signal())).map(e=>e.file.path),['renamed/a.gcode','renamed/sub/b.gcode','outside.gcode']);}finally{held.resolve();injected.mock.restore();}
 }finally{await f.close();}
});
