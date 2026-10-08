import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,open,rm,readdir,stat,chmod,unlink,readlink,utimes,rename,type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {pathToFileURL} from 'node:url';
import {externalAcceptanceBundle,assertAcceptanceBundleUnchanged} from './helpers/acceptance-bundle.ts';
const retained=await externalAcceptanceBundle();if(retained)after(()=>assertAcceptanceBundleUnchanged(retained));
const {PublishedPrintFiles,PublishedDeleteCommitError}=retained?await import(pathToFileURL(join(retained.path,'host/src/storage/published-files.js')).href) as typeof import('../src/storage/published-files.ts'):await import('../src/storage/published-files.ts');
const {validateReplacementIntent,replacementNamespaceHash}=retained?await import(pathToFileURL(join(retained.path,'host/src/storage/namespace-replace.js')).href) as typeof import('../src/storage/namespace-replace.ts'):await import('../src/storage/namespace-replace.ts');
const {validateCopyIntent}=retained?await import(pathToFileURL(join(retained.path,'host/src/storage/namespace-copy.js')).href) as typeof import('../src/storage/namespace-copy.ts'):await import('../src/storage/namespace-copy.ts');
const {validateMoveIntent}=retained?await import(pathToFileURL(join(retained.path,'host/src/storage/namespace-move.js')).href) as typeof import('../src/storage/namespace-move.ts'):await import('../src/storage/namespace-move.ts');
const signal=()=>new AbortController().signal;
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(options:Parameters<typeof PublishedPrintFiles.open>[1]={}){
 const dir=await mkdtemp(join(tmpdir(),'published-preview-')),root=join(dir,'files'),handles:FileHandle[]=[];
 const models=[Buffer.from('G1 X0.12345678901234567 E0.01\r\n'),Buffer.from('G1 X9\n')];
 const previews=await Promise.all(['red','blue'].map(background=>sharp({create:{width:32,height:32,channels:3,background}}).png().toBuffer()));
 for(const [i,bytes] of [...models,...previews].entries()){const path=join(dir,'source-'+i);await writeFile(path,bytes);handles.push(await open(path,'r'));}
 let store=await PublishedPrintFiles.open(root,options);
 return {dir,root,models,previews,handles,get store(){return store;},async publish(id:string,model=0,preview=0,path=id+'.gcode'){return store.publish(id,path.split('/').at(-1)!,handles[model],signal(),path,handles[preview+2]);},async reopen(input=options){await store.close();store=await PublishedPrintFiles.open(root,input);},async close(){await store.close();await Promise.all(handles.map(handle=>handle.close()));await rm(dir,{recursive:true,force:true});}};
}
async function charged(root:string){return (await Promise.all((await readdir(root)).map(async name=>(await stat(join(root,name))).size))).reduce((a,b)=>a+b,0);}
async function image(root:string){return Promise.all((await readdir(root)).sort().map(async name=>[name,(await readFile(join(root,name))).toString('hex')]));}
test('concurrent identical preview publications charge one blob and retain both authorities',async()=>{
 const f=await fixture();try{
  const [one,two]=await Promise.all([f.publish('one'),f.publish('two')]);assert.deepEqual(one.preview,two.preview);
  assert.equal((await readdir(f.root)).filter(name=>name.endsWith('.png')).length,1);assert.equal(f.store.status.storedBytes,await charged(f.root));assert.equal(f.store.status.reservedBytes,0);
  await f.store.remove('one',signal());assert.deepEqual((await f.store.readPreview('two',signal()))!.bytes,f.previews[0]);await f.reopen();await f.store.remove('two',signal());assert.equal(f.store.status.storedBytes,0);
 }finally{await f.close();}
});
for(const suffix of ['gcode','png'])for(const code of ['EIO','ENOSPC','ENOENT'])test(`deduplicated ${suffix} durability failure ${code} never publishes a new authority`,async t=>{
 const f=await fixture();try{
  const original=await f.publish('original'),blob=join(f.root,(suffix==='gcode'?original.sha256:original.preview!.sha256)+'.'+suffix);
  const prototype=Object.getPrototypeOf(f.handles[0]) as FileHandle,previous=prototype.sync;
  let injected=false;t.mock.method(prototype,'sync',async function(this:FileHandle){if(await readlink('/proc/self/fd/'+this.fd)===blob){injected=true;throw Object.assign(new Error('Injected reused content durability failure'),{code});}return previous.call(this);});
  await assert.rejects(f.publish('uncommitted'),{code});assert(injected);t.mock.restoreAll();
  await assert.rejects(f.store.inspect('uncommitted'),{code:'ENOENT'});assert.deepEqual(await f.store.inspect('original'),original);
  assert.deepEqual((await f.store.readBytes('original',signal())).bytes,f.models[0]);assert.deepEqual((await f.store.readPreview('original',signal()))!.bytes,f.previews[0]);
  assert.equal(f.store.status.reservedBytes,0);assert.equal(f.store.status.storedBytes,await charged(f.root));assert(!(await readdir(f.root)).some(name=>name.startsWith('.')));
  await f.reopen();assert.deepEqual(await f.store.inspect('original'),original);const next=await f.publish('next');assert.deepEqual(next.preview,original.preview);
 }finally{t.mock.restoreAll();await f.close();}
});
for(const code of ['EIO','ENOSPC','ENOENT'])test(`reused preview sync failure ${code} cannot retire the replaced authority`,async t=>{
 const f=await fixture();try{
  const original=await f.publish('original'),blob=join(f.root,original.preview!.sha256+'.png'),plan=await f.store.prepareUploadReplacement('uncommitted','original.gcode','original.gcode',signal());
  const prototype=Object.getPrototypeOf(f.handles[0]) as FileHandle,previous=prototype.sync;let injected=false;
  t.mock.method(prototype,'sync',async function(this:FileHandle){if(await readlink('/proc/self/fd/'+this.fd)===blob){injected=true;throw Object.assign(new Error('Injected reused preview durability failure'),{code});}return previous.call(this);});
  await assert.rejects(f.store.replaceUpload(plan,f.handles[1],signal(),f.handles[2]),{code});assert(injected);t.mock.restoreAll();
  assert.equal(await f.store.resolvePath('original.gcode',signal()),'original');await assert.rejects(f.store.inspect('uncommitted'),{code:'ENOENT'});
  assert.deepEqual((await f.store.readBytes('original',signal())).bytes,f.models[0]);assert.deepEqual((await f.store.readPreview('original',signal()))!.bytes,f.previews[0]);
  assert.equal(f.store.status.reservedBytes,0);assert.equal(f.store.status.storedBytes,await charged(f.root));assert(!(await readdir(f.root)).some(name=>name.startsWith('.')));
  await f.reopen();assert.deepEqual(await f.store.inspect('original'),original);
 }finally{t.mock.restoreAll();await f.close();}
});
for(const sharedModel of [false,true])test(`one receipt binds exact model and preview through dedup, restart and last-reference deletion (sharedModel=${sharedModel})`,async()=>{
 const f=await fixture();try{
  const one=await f.publish('one'),two=await f.publish('two',sharedModel?0:1);
  assert.deepEqual(one.preview,{sha256:sha(f.previews[0]),size:f.previews[0].length});assert(Object.isFrozen(one.preview));
  assert.deepEqual((await f.store.readBytes('one',signal())).bytes,f.models[0]);assert.deepEqual((await f.store.readPreview('two',signal()))!.bytes,f.previews[0]);
  assert.equal((await readdir(f.root)).filter(name=>name.endsWith('.png')).length,1);
  assert.equal(f.store.status.storedBytes,await charged(f.root));assert.equal(f.store.status.reservedBytes,0);
  await f.reopen();assert.deepEqual(await f.store.inspect('one'),one);await f.store.remove('one',signal(),one);
  assert.deepEqual((await f.store.readPreview('two',signal(),two))!.bytes,f.previews[0]);await f.reopen();
  await f.store.remove('two',signal(),two);assert.deepEqual(await readdir(f.root),[]);assert.equal(f.store.status.storedBytes,0);
 }finally{await f.close();}
});
for(const sharePreview of [false,true])for(const move of [false,true])test(`copy/move overwrite retains source preview and frees only retired content (move=${move}, sharedPreview=${sharePreview})`,async()=>{
 const f=await fixture();try{
  await f.publish('source',0,0);await f.publish('old',0,sharePreview?0:1,'target.gcode');
  if(move)await f.store.moveFile(await f.store.prepareFileMove('source.gcode','target.gcode',signal()),signal());
  else await f.store.copy(await f.store.prepareCopy('source.gcode','target.gcode',signal()),signal());
  const id=await f.store.resolvePath('target.gcode',signal());assert.deepEqual((await f.store.readPreview(id,signal()))!.bytes,f.previews[0]);
  await assert.rejects(f.store.inspect('old'),{code:'ENOENT'});assert.equal((await readdir(f.root)).filter(name=>name.endsWith('.png')).length,1);
  assert.equal(f.store.status.storedBytes,await charged(f.root));await f.reopen();assert.equal(f.store.status.storedBytes,await charged(f.root));
  for(const id of await f.store.listIds(signal()))await f.store.remove(id,signal());assert.equal(f.store.status.storedBytes,0);
 }finally{await f.close();}
});
test('directory copy, move and recursive delete preserve previews and surviving shared references',async()=>{
 const f=await fixture();try{
  await f.store.mutateDirectory('tree',false,signal());await f.publish('one',0,0,'tree/one.gcode');await f.publish('two',0,1,'tree/two.gcode');await f.publish('outside',1,0);
  const copied=await f.store.copy(await f.store.prepareCopy('tree','copy',signal()),signal());assert.equal(copied.entries.length,2);
  await f.store.moveDirectory(await f.store.prepareDirectoryMove('copy','moved',signal()),signal());await f.reopen();
  for(const [path,preview] of [['moved/one.gcode',0],['moved/two.gcode',1]] as const)assert.deepEqual((await f.store.readPreview(await f.store.resolvePath(path,signal()),signal()))!.bytes,f.previews[preview]);
  await f.store.deleteDirectory(await f.store.prepareDirectoryDelete('tree',signal()),signal());await f.store.deleteDirectory(await f.store.prepareDirectoryDelete('moved',signal()),signal());
  assert.deepEqual((await f.store.readPreview('outside',signal()))!.bytes,f.previews[0]);assert.equal((await readdir(f.root)).filter(name=>name.endsWith('.png')).length,1);
  assert.equal(f.store.status.storedBytes,await charged(f.root));await f.reopen();await f.store.remove('outside',signal());assert.equal((await readdir(f.root)).filter(name=>name.endsWith('.png')).length,0);
 }finally{await f.close();}
});
for(const preview of [undefined,0,1])test(`upload overwrite replaces preview atomically and clears old preview for plain G-code (preview=${preview})`,async()=>{
 const f=await fixture();try{
  await f.publish('old');const plan=await f.store.prepareUploadReplacement('new','old.gcode','old.gcode',signal());
  const record=await f.store.replaceUpload(plan,f.handles[1],signal(),preview===undefined?undefined:f.handles[preview+2]);
  assert.deepEqual((await f.store.readBytes('new',signal())).bytes,f.models[1]);
  if(preview===undefined){assert.equal(record.preview,undefined);assert.equal(await f.store.readPreview('new',signal()),undefined);}
  else assert.deepEqual((await f.store.readPreview('new',signal()))!.bytes,f.previews[preview]);
  assert.equal(f.store.status.storedBytes,await charged(f.root));await f.reopen();assert.deepEqual(await f.store.inspect('new'),record);await f.store.remove('new',signal());assert.equal(f.store.status.storedBytes,0);
 }finally{await f.close();}
});
for(const prefix of [0,1,2])test(`replacement recovers model and preview together from durable prefix ${prefix}`,async()=>{
 const f=await fixture();try{
  const source=await f.publish('source',1,1);await f.publish('old',0,0,'target.gcode');
  const prepared=await f.store.prepareUploadReplacement('new','target.gcode','target.gcode',signal());
  const plan=validateReplacementIntent({version:1,action:'create_file',created:{...source,id:'new',name:'target.gcode',path:'target.gcode'},replaced:prepared.replaced,modified:1,namespaceSha256:prepared.namespaceSha256,directories:prepared.directories});
  await f.store.close();await writeFile(join(f.root,'.namespace-replace.json'),JSON.stringify(plan),{mode:0o600});
  if(prefix>=1){const temp=join(f.root,'.receipt-00000000-0000-4000-8000-000000000001');await writeFile(temp,JSON.stringify(plan.created),{mode:0o400});await utimes(temp,1,1);await rename(temp,join(f.root,'new.json'));}
  if(prefix>=2)await unlink(join(f.root,'old.json'));
  for(let i=0;i<2;i++){await f.reopen();assert.deepEqual((await f.store.readPreview('new',signal()))!.bytes,f.previews[1]);assert.equal(f.store.status.storedBytes,await charged(f.root));assert.equal((await readdir(f.root)).filter(name=>name.endsWith('.png')).length,1);}
 }finally{await f.close();}
});
for(const defect of ['missing','size','schema'])test(`invalid preview ${defect} prevents recovery garbage collection`,async()=>{
 const f=await fixture();try{
  const record=await f.publish('one');await f.store.close();
  if(defect==='missing')await unlink(join(f.root,record.preview!.sha256+'.png'));
  if(defect==='size'){await chmod(join(f.root,record.preview!.sha256+'.png'),0o600);await writeFile(join(f.root,record.preview!.sha256+'.png'),'x');}
  if(defect==='schema'){await chmod(join(f.root,'one.json'),0o600);await writeFile(join(f.root,'one.json'),JSON.stringify({...record,preview:{...record.preview,unknown:true}}));}
  await writeFile(join(f.root,'.preview-00000000-0000-4000-8000-000000000001'),'orphan',{mode:0o600});const before=await image(f.root);
  await assert.rejects(f.reopen());assert.deepEqual(await image(f.root),before);
 }finally{await f.close();}
});
test('preview acquisition detects same-size corruption and changed expected authority',async()=>{
 const f=await fixture();try{
  const record=await f.publish('one');await assert.rejects(f.store.readPreview('one',signal(),{...record,preview:{...record.preview!,sha256:'0'.repeat(64)}}),/receipt changed/);
  const changed=Buffer.from(f.previews[0]);changed[changed.length-1]^=1;await chmod(join(f.root,record.preview!.sha256+'.png'),0o600);await writeFile(join(f.root,record.preview!.sha256+'.png'),changed);
  await assert.rejects(f.store.readPreview('one',signal()),/digest/);
 }finally{await f.close();}
});
test('recursive delete validates each distinct preview even when all model hashes match',async()=>{
 const f=await fixture();try{
  await f.store.mutateDirectory('tree',false,signal());await f.publish('one',0,0,'tree/one.gcode');const two=await f.publish('two',0,1,'tree/two.gcode');
  const plan=await f.store.prepareDirectoryDelete('tree',signal()),corrupt=Buffer.from(f.previews[1]);corrupt[corrupt.length-1]^=1;
  await chmod(join(f.root,two.preview!.sha256+'.png'),0o600);await writeFile(join(f.root,two.preview!.sha256+'.png'),corrupt);const before=await image(f.root);
  await assert.rejects(f.store.deleteDirectory(plan,signal()),error=>error instanceof PublishedDeleteCommitError&&error.phase==='before-intent'&&error.cause instanceof Error&&/digest mismatch/.test(error.cause.message));
  assert.deepEqual(await image(f.root),before);assert.equal(f.store.status.reservedBytes,0);assert.equal(f.store.status.writeFault,undefined);
 }finally{await f.close();}
});
test('preview capacity is reserved before any model or preview staging writes',async()=>{
 const f=await fixture({maxStorageBytes:2048+30});try{
  await assert.rejects(f.publish('one'),/quota/);assert.deepEqual(await readdir(f.root),[]);assert.equal(f.store.status.reservedBytes,0);
  await assert.rejects(f.store.publish('invalid','invalid.gcode',f.handles[0],signal(),'invalid.gcode',f.handles[1]),/PNG/);assert.deepEqual(await readdir(f.root),[]);
 }finally{await f.close();}
});
test('cancelled borrowed preview reads drain before return and do not publish a half receipt',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),controller=new AbortController();let calls=0;
 const preview={stat:()=>f.handles[2].stat({bigint:true}),read:async(...args:Parameters<FileHandle['read']>)=>{if(++calls===2){entered.resolve();await release.promise;}return f.handles[2].read(...args);}} as unknown as FileHandle;
 try{
  const pending=f.store.publish('one','one.gcode',f.handles[0],controller.signal,'one.gcode',preview),rejected=assert.rejects(pending,/cancel preview/);await entered.promise;controller.abort(new Error('cancel preview'));
  let finished=false;void pending.then(()=>{finished=true;},()=>{finished=true;});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(finished,false);
  release.resolve();await rejected;await assert.rejects(f.store.inspect('one'),{code:'ENOENT'});assert.equal(f.store.status.reservedBytes,0);
  await f.reopen();assert.deepEqual(await readdir(f.root),[]);assert.equal(f.store.status.storedBytes,0);assert((await f.handles[2].stat()).isFile());
 }finally{release.resolve();await f.close();}
});
test('failed receipt directory sync fences authority and reopens one complete model/preview pair',async t=>{
 const f=await fixture(),proto=Object.getPrototypeOf(f.handles[0]),sync=proto.sync;let injected=false;
 const mock=t.mock.method(proto,'sync',async function(this:FileHandle){if(!injected&&(await this.stat()).isDirectory()&&(await readdir(f.root)).includes('one.json')){injected=true;throw new Error('receipt sync failed');}return sync.call(this);});
 try{
  await assert.rejects(f.publish('one'),/receipt sync failed/);mock.mock.restore();assert(f.store.status.writeFault);await assert.rejects(f.store.inspect('one'),{message:'Published reads require recovery'});
  for(let i=0;i<2;i++){await f.reopen();assert.deepEqual((await f.store.readBytes('one',signal())).bytes,f.models[0]);assert.deepEqual((await f.store.readPreview('one',signal()))!.bytes,f.previews[0]);assert.equal(f.store.status.storedBytes,await charged(f.root));}
 }finally{mock.mock.restore();await f.close();}
});
test('namespace hashes preserve legacy rows and bind preview identities in every journal',async()=>{
 const f=await fixture();try{
  const record=await f.publish('one'),plain={version:1 as const,id:'legacy',name:'legacy.gcode',sha256:sha(f.models[0]),size:f.models[0].length};
  assert.equal(await replacementNamespaceHash([plain],[]),sha(Buffer.from(JSON.stringify([plain.id,plain.sha256,plain.size,plain.name,'legacy.gcode'])+'\n[]')));
  assert.notEqual(await replacementNamespaceHash([record],[]),await replacementNamespaceHash([{...record,preview:undefined}],[]));
  const copy=await f.store.prepareCopy('one.gcode','copy.gcode',signal()),changed={...copy,entries:copy.entries.map(entry=>({...entry,created:{...entry.created,preview:{...entry.created.preview!,sha256:'0'.repeat(64)}}}))};
  assert.throws(()=>validateCopyIntent(changed),/identity/);
  await f.store.mutateDirectory('tree',false,signal());await f.store.moveFile(await f.store.prepareFileMove('one.gcode','tree/one.gcode',signal()),signal());
  const move=await f.store.prepareDirectoryMove('tree','moved',signal()),corrupt={...move,changed:move.changed.map(entry=>({...entry,after:{...entry.after,preview:{...entry.after.preview!,sha256:'0'.repeat(64)}}}))};assert.throws(()=>validateMoveIntent(corrupt),/identity/);
 }finally{await f.close();}
});
