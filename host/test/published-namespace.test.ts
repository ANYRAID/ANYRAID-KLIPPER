import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm,chmod,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
const signal=()=>new AbortController().signal;
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'namespace-preparation-')),root=join(directory,'store'),sourcePath=join(directory,'source');
 await writeFile(sourcePath,'G1 X1\n');const source=await open(sourcePath,'r');let store=await PublishedPrintFiles.open(root);
 return {directory,root,source,get store(){return store;},async reopen(){await store.close();store=await PublishedPrintFiles.open(root);},async close(){await store.close();await source.close();await rm(directory,{recursive:true,force:true});}};
}
test('visible nested names recover with legacy IDs and independent immutable content snapshots',async()=>{
 const f=await fixture();let reader:Awaited<ReturnType<PublishedPrintFiles['acquire']>>|undefined;
 try{
  await f.store.mutateDirectory('零件',false,signal());await f.store.mutateDirectory('零件/首批',false,signal());
  const legacy=await f.store.publish('legacy','旧文件.gcode',f.source,signal());
  const nested=await f.store.publish('nested','50% test.gcode',f.source,signal(),'零件/首批/50% test.gcode');
  assert.equal(legacy.sha256,nested.sha256);assert.equal(legacy.path,undefined);assert.equal(await f.store.resolvePath('legacy.gcode',signal()),'legacy');
  const before=await f.store.describeSource('nested',signal());await f.reopen();assert.deepEqual(await f.store.describeSource('nested',signal()),before);
  assert.deepEqual((await f.store.directoryCatalog('',signal())).directories.map(d=>d.path),['零件']);
  assert.deepEqual((await f.store.directoryCatalog('零件/首批',signal())).files.map(e=>e.file.path),['零件/首批/50% test.gcode']);
  assert.equal(await f.store.resolvePath(nested.path!,signal()),nested.id);
  reader=await f.store.acquire(nested.id,signal());await assert.rejects(f.store.mutateDirectory('零件/首批',true,signal()),{code:'ENOTEMPTY'});
  await f.store.remove(nested.id,signal(),nested);await assert.rejects(f.store.resolvePath(nested.path!,signal()),{code:'ENOENT'});
  await f.store.mutateDirectory('零件/首批',true,signal());await f.store.mutateDirectory('零件',true,signal());
  const batch=(await reader.next(signal()))!;assert.equal(batch.script,'G1 X1');reader.commit(batch);await reader.close();reader=undefined;
  await f.reopen();assert.deepEqual((await f.store.directoryCatalog('',signal())).directories,[]);assert.deepEqual(await f.store.inspect('legacy'),legacy);
 }finally{await reader?.close();await f.close();}
});
test('two receipt IDs cannot claim one visible path, and namespace mutation waits for an admitted publication',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const held={stat:()=>f.source.stat({bigint:true}),read:async(buffer:Buffer,offset:number,length:number,position:number)=>{entered.resolve();await release.promise;return f.source.read(buffer,offset,length,position);}} as unknown as import('node:fs/promises').FileHandle;
 try{
  await f.store.mutateDirectory('parts',false,signal());const publication=f.store.publish('one','same.gcode',held,signal(),'parts/same.gcode');await entered.promise;
  await assert.rejects(f.store.publish('two','same.gcode',f.source,signal(),'parts/same.gcode'),{code:'EEXIST'});
  let settled=false;const deletion=f.store.mutateDirectory('parts',true,signal());void deletion.then(()=>settled=true,()=>settled=true);const rejected=assert.rejects(deletion,{code:'ENOTEMPTY'});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);release.resolve();await publication;await rejected;
  assert.equal(await f.store.resolvePath('parts/same.gcode',signal()),'one');assert.equal(f.store.status.pendingPublications,0);assert.equal(f.store.status.reservedBytes,0);await assert.rejects(f.store.inspect('two'),{code:'ENOENT'});
 }finally{release.resolve();await f.close();}
});
test('unsafe or absent parents do not publish receipts or reserve storage',async()=>{
 const f=await fixture();try{
  for(const path of ['/outside.gcode','../outside.gcode','parts/../x.gcode','parts//x.gcode','parts\\x.gcode','.thumbs/x.gcode','x\0.gcode','\ud800.gcode'])await assert.rejects(f.store.publish('unsafe','x.gcode',f.source,signal(),path));
  await assert.rejects(f.store.publish('missing','x.gcode',f.source,signal(),'missing/x.gcode'),{code:'ENOENT'});
  assert.deepEqual(await readdir(f.root),[]);assert.equal(f.store.status.reservedBytes,0);assert.equal(f.store.status.publishedFiles,0);
 }finally{await f.close();}
});
test('external receipt path changes reject live reads and recovery before deleting unknown-to-owner temporary bytes',async()=>{
 const f=await fixture();try{
  const record=await f.store.publish('one','x.gcode',f.source,signal());const receipt=join(f.root,'one.json');await chmod(receipt,0o600);await writeFile(receipt,JSON.stringify({...record,path:'absent/x.gcode'}));
  await assert.rejects(f.store.describe('one',signal()),/changed outside/);await f.store.close();
  const temp='.upload-00000000-0000-0000-0000-000000000000';await writeFile(join(f.root,temp),'preserve');await assert.rejects(PublishedPrintFiles.open(f.root),/namespace/);
  assert.ok((await readdir(f.root)).includes(temp));
 }finally{await f.close();}
});
