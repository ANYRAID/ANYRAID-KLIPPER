import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm,chmod,readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {PublishedDirectoryCommitError} from '../src/storage/published-paths.ts';
const signal=()=>new AbortController().signal;
async function fixture(options:{maxPublishedFiles?:number}={}){
 const directory=await mkdtemp(join(tmpdir(),'namespace-preparation-')),root=join(directory,'store'),sourcePath=join(directory,'source');
 await writeFile(sourcePath,'G1 X1\n');const source=await open(sourcePath,'r');let store=await PublishedPrintFiles.open(root,options);
 return {directory,root,source,get store(){return store;},async reopen(){await store.close();store=await PublishedPrintFiles.open(root,options);},async close(){await store.close();await source.close();await rm(directory,{recursive:true,force:true});}};
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
test('upload parent creation preserves existing timestamps, emits only new ancestors and recovers names and bytes',async()=>{
 const f=await fixture(),events:any[]=[];try{
  await f.store.mutateDirectory('零件',false,signal());const before=(await f.store.directoryCatalog('',signal())).directories[0];f.store.observeDirectories(event=>events.push(event));
  const path='零件/50%/首批/model.gcode';assert.equal((await f.store.ensureUploadParents(path,signal())).length,2);
  assert.deepEqual(events.map(event=>event.path),['零件/50%','零件/50%/首批']);assert.deepEqual((await f.store.directoryCatalog('',signal())).directories[0],before);
  const manifest=await readFile(join(f.root,'.directories.json'));assert.deepEqual(await f.store.ensureUploadParents(path,signal()),[]);assert.equal(events.length,2);assert.deepEqual(await readFile(join(f.root,'.directories.json')),manifest);
  const record=await f.store.publish('nested','model.gcode',f.source,signal(),path);await f.reopen();assert.equal(await f.store.resolvePath(path,signal()),'nested');assert.equal((await f.store.inspect('nested')).sha256,record.sha256);assert.equal(await f.store.hasDirectory('零件/50%/首批',signal()),true);
 }finally{await f.close();}
});
test('upload parent plans reject invalid, occupied and aborted paths without partial directories',async()=>{
 const f=await fixture();try{
  for(const path of ['../x/model.gcode','safe//model.gcode','.thumbs/model.gcode','safe/../model.gcode'])await assert.rejects(f.store.ensureUploadParents(path,signal()));
  const cancelled=new AbortController();cancelled.abort(new Error('cancel parent creation'));await assert.rejects(f.store.ensureUploadParents('cancel/sub/model.gcode',cancelled.signal),/cancel parent/);assert.deepEqual(await readdir(f.root),[]);
  await f.store.publish('one','occupied.gcode',f.source,signal(),'occupied.gcode');await assert.rejects(f.store.ensureUploadParents('occupied.gcode/sub/model.gcode',signal()),{code:'EEXIST'});assert.deepEqual((await f.store.directoryCatalog('',signal())).directories,[]);
  await f.store.mutateDirectory('target.gcode',false,signal());await assert.rejects(f.store.ensureUploadParents('target.gcode',signal()),{code:'EEXIST'});assert.equal(f.store.status.reservedBytes,0);
 }finally{await f.close();}
});
test('one upload ancestor plan cannot exceed the directory cap or leave its accepted prefix',async()=>{
 const f=await fixture();try{
  for(let i=0;i<33;i++)await f.store.ensureUploadParents(['r'+i,...Array(30).fill('x'),'model.gcode'].join('/'),signal());
  const manifest=await readFile(join(f.root,'.directories.json'));await assert.rejects(f.store.ensureUploadParents('last/deep/model.gcode',signal()),/directory limit/);assert.deepEqual(await readFile(join(f.root,'.directories.json')),manifest);assert.equal(await f.store.hasDirectory('last',signal()),false);assert.equal(f.store.status.pendingOperations,0);
 }finally{await f.close();}
});
test('upload parent directory bytes share storage quota and failed reservation has no events or files',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'upload-parent-quota-')),root=join(directory,'store'),store=await PublishedPrintFiles.open(root,{maxStorageBytes:1}),events:any[]=[];
 try{store.observeDirectories(event=>events.push(event));await assert.rejects(store.ensureUploadParents('one/two/model.gcode',signal()),/quota|storage/i);assert.deepEqual(await readdir(root),[]);assert.deepEqual(events,[]);assert.equal(store.status.storedBytes,0);assert.equal(store.status.reservedBytes,0);}finally{await store.close();await rm(directory,{recursive:true,force:true});}
});
test('upload parent sync failures report the durability phase and require recovery after replacement',async t=>{
 for(const phase of ['before-replace','replaced'] as const){
  const f=await fixture(),prototype=Object.getPrototypeOf(f.source),original=prototype.sync,events:any[]=[];let injected=false;
  const mock=t.mock.method(prototype,'sync',async function(this:import('node:fs/promises').FileHandle){const directory=(await this.stat()).isDirectory();if(!injected&&directory===(phase==='replaced')){injected=true;throw new Error('parent sync failed');}return original.call(this);});
  try{f.store.observeDirectories(event=>events.push(event));await assert.rejects(f.store.ensureUploadParents('one/two/model.gcode',signal()),error=>error instanceof PublishedDirectoryCommitError&&error.phase===phase);assert.equal(injected,true);assert.deepEqual(events,[]);assert.equal(f.store.status.publishedFiles,0);assert.equal(Boolean(f.store.status.writeFault),phase==='replaced');mock.mock.restore();await f.reopen();assert.equal(await f.store.hasDirectory('one/two',signal()),phase==='replaced');}finally{mock.mock.restore();await f.close();}
 }
});
test('upload parent planning waits for admitted publication and sees its resulting file collision',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();const held={stat:()=>f.source.stat({bigint:true}),read:async(buffer:Buffer,offset:number,length:number,position:number)=>{entered.resolve();await release.promise;return f.source.read(buffer,offset,length,position);}} as unknown as import('node:fs/promises').FileHandle;
 try{const publication=f.store.publish('one','parent.gcode',held,signal(),'parent.gcode');await entered.promise;let settled=false;const planning=f.store.ensureUploadParents('parent.gcode/sub/model.gcode',signal());void planning.then(()=>settled=true,()=>settled=true);const rejected=assert.rejects(planning,{code:'EEXIST'});await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);release.resolve();await publication;await rejected;assert.deepEqual((await f.store.directoryCatalog('',signal())).directories,[]);}finally{release.resolve();await f.close();}
});
test('later file quota rejection preserves durable empty upload parents and existing file identity',async()=>{
 const f=await fixture({maxPublishedFiles:1});try{const original=await f.store.publish('one','one.gcode',f.source,signal(),'one.gcode');await f.store.ensureUploadParents('empty/sub/model.gcode',signal());await assert.rejects(f.store.publish('two','model.gcode',f.source,signal(),'empty/sub/model.gcode'),/limit|quota/i);assert.equal(f.store.status.publishedFiles,1);assert.equal(f.store.status.reservedBytes,0);await f.reopen();assert.equal(await f.store.hasDirectory('empty/sub',signal()),true);assert.deepEqual((await f.store.directoryCatalog('empty/sub',signal())).files,[]);assert.deepEqual(await f.store.inspect('one'),original);}finally{await f.close();}
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
