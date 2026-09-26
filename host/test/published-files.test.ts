import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm,chmod,readdir,rename,mkdir,symlink,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {PrintSnapshotBudget} from '../src/gcode/snapshot-budget.ts';
const signal=()=>new AbortController().signal;
async function fixture(options:Parameters<typeof PublishedPrintFiles.open>[1]={}){const directory=await mkdtemp(join(tmpdir(),'published-files-')),root=join(directory,'store'),path=join(directory,'source');await writeFile(path,'G1 X1\n');const source=await open(path,'r'),store=await PublishedPrintFiles.open(root,options);return {directory,root,path,source,store,async close(){await store.close();await source.close();await rm(directory,{recursive:true,force:true});}};}
test('durable publication survives reopen and yields a sealed snapshot with matching metadata',async()=>{
 const f=await fixture();try{const record=await f.store.publish('job','零件.gcode',f.source,signal());assert.equal(record.size,6);await f.store.close();const reopened=await PublishedPrintFiles.open(f.root);try{assert.deepEqual(await reopened.inspect('job'),record);const reader=await reopened.acquire('job',signal());try{await chmod(join(f.root,record.sha256+'.gcode'),0o600);await writeFile(join(f.root,record.sha256+'.gcode'),'G1 X9\n');const batch=(await reader.next(signal()))!;assert.equal(batch.script,'G1 X1');reader.commit(batch);}finally{await reader.close();}}finally{await reopened.close();}}finally{await f.close();}
});
test('receipt source identity survives reopening and distinguishes identical content republished under the same ID',async()=>{
 const f=await fixture();try{
  await f.store.publish('job','file.gcode',f.source,signal());await f.store.publish('shared','file.gcode',f.source,signal());const original=await f.store.describeSource('job',signal()),shared=await f.store.describeSource('shared',signal());assert.equal(original.file.sha256,shared.file.sha256);assert.notDeepEqual(original.source,shared.source);assert(Object.isFrozen(original.source));for(const value of Object.values(original.source))assert.equal(typeof value,'bigint');
  await f.store.close();const next=await PublishedPrintFiles.open(f.root);try{
   assert.deepEqual(await next.describeSource('job',signal()),original);await next.remove('job',signal());await assert.rejects(next.describeSource('job',signal()),{code:'ENOENT'});await next.publish('job','file.gcode',f.source,signal());const replacement=await next.describeSource('job',signal());assert.deepEqual(replacement.file,original.file);assert.notDeepEqual(replacement.source,original.source);assert.deepEqual((await next.describeSource('shared',signal())).source,shared.source);
  }finally{await next.close();}
 }finally{await f.close();}
});
test('unsafe IDs, duplicate IDs and symlink content cannot replace or escape publications',async()=>{
 const f=await fixture();try{for(const id of ['../file','a/b','','.','x\0'])await assert.rejects(f.store.publish(id,'file',f.source,signal()),/identifier/);const record=await f.store.publish('job','file',f.source,signal());await assert.rejects(f.store.publish('job','other',f.source,signal()),{code:'EEXIST'});assert.equal((await f.store.inspect('job')).name,'file');const blob=join(f.root,record.sha256+'.gcode');await unlink(blob);await symlink(f.path,blob);await assert.rejects(f.store.acquire('job',signal()),{code:'ELOOP'});await assert.rejects(f.store.publish('other','file',f.source,signal()),{code:'ELOOP'});}finally{await f.close();}
});
test('corrupt stored data and malformed receipts fail before printing',async()=>{
 const f=await fixture();try{const record=await f.store.publish('job','file',f.source,signal()),blob=join(f.root,record.sha256+'.gcode');await chmod(blob,0o600);await writeFile(blob,'G1 X9\n');await assert.rejects(f.store.acquire('job',signal()),/digest/);await assert.rejects(f.store.publish('other','file',f.source,signal()),/digest/);const receipt=join(f.root,'job.json');await chmod(receipt,0o600);await writeFile(receipt,JSON.stringify({...record,sha256:'../../source'}));await assert.rejects(f.store.acquire('job',signal()),/receipt/);await writeFile(receipt,'x'.repeat(2049));await assert.rejects(f.store.inspect('job'),/receipt/);}finally{await f.close();}
});
test('directory descriptor keeps publications anchored if configured path is replaced',async()=>{
 const f=await fixture();try{const moved=join(f.directory,'moved');await rename(f.root,moved);await mkdir(f.root,{mode:0o700});const record=await f.store.publish('job','file',f.source,signal());assert.equal((await f.store.inspect('job')).sha256,record.sha256);assert.deepEqual(await readdir(f.root),[]);assert.ok((await readdir(moved)).includes('job.json'));}finally{await f.close();}
});
test('operation admission is bounded and close waits a cancelled in-flight publication',async()=>{
 const f=await fixture({maxOperations:1}),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),controller=new AbortController();
 const source={stat:()=>f.source.stat({bigint:true}),read:async(buffer:Buffer,offset:number,length:number,position:number)=>{entered.resolve();await release.promise;return f.source.read(buffer,offset,length,position);}} as unknown as import('node:fs/promises').FileHandle;
 try{const publishing=f.store.publish('job','file',source,controller.signal),rejected=assert.rejects(publishing);await entered.promise;await assert.rejects(f.store.inspect('job'),/limit/);let closed=false;const closing=f.store.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);controller.abort();release.resolve();await rejected;await closing;assert.deepEqual(await readdir(f.root),[]);await assert.rejects(f.store.inspect('job'),/closed/);}finally{release.resolve();await f.close();}
});
test('acquisition uses shared snapshot budget and snapshots outlive store closure',async()=>{
 const budget=new PrintSnapshotBudget({maxSnapshots:1}),f=await fixture({budget});try{await f.store.publish('job','file',f.source,signal());const reader=await f.store.acquire('job',signal());try{await assert.rejects(f.store.acquire('job',signal()),/quota/);await f.store.close();const batch=(await reader.next(signal()))!;assert.equal(batch.script,'G1 X1');reader.commit(batch);}finally{await reader.close();}assert.equal(budget.status.reservations,0);}finally{await f.close();}
});
test('concurrent publishers cannot overwrite the winning ID and duplicate content is verified',async()=>{
 const f=await fixture(),otherPath=join(f.directory,'other');await writeFile(otherPath,'G1 X2\n');const other=await open(otherPath,'r');
 try{const results=await Promise.allSettled([f.store.publish('race','first',f.source,signal()),f.store.publish('race','second',other,signal())]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);const winner=results.find(r=>r.status==='fulfilled')!;assert.equal(winner.status,'fulfilled');if(winner.status==='fulfilled')assert.deepEqual(await f.store.inspect('race'),winner.value);
 const one=await f.store.publish('copy1','file',f.source,signal()),two=await f.store.publish('copy2','file',f.source,signal());assert.equal(one.sha256,two.sha256);assert.equal((await readdir(f.root)).filter(name=>name===one.sha256+'.gcode').length,1);assert.equal((await readdir(f.root)).some(name=>name.startsWith('.')),false);
 }finally{await other.close();await f.close();}
});
test('store refuses symlink roots and directories accessible to other users',async()=>{
 const f=await fixture();try{const alias=join(f.directory,'alias');await symlink(f.root,alias);await assert.rejects(PublishedPrintFiles.open(alias));await chmod(f.root,0o755);await assert.rejects(PublishedPrintFiles.open(f.root),/private/);await chmod(f.root,0o700);}finally{await f.close();}
});
