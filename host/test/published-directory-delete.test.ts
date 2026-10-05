import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,open,writeFile,readFile,readdir,readlink,stat,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PublishedPrintFiles,PublishedDeleteCommitError,PublishedFileChangedError} from '../src/storage/published-files.ts';
import {validateDeleteIntent} from '../src/storage/namespace-delete.ts';
const signal=()=>new AbortController().signal;
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'directory-delete-')),root=join(dir,'files');await mkdir(root,{mode:0o700});
 await writeFile(join(dir,'source'),'G1 X1\n');await writeFile(join(dir,'second'),'G1 X2\n');const source=await open(join(dir,'source'),'r'),second=await open(join(dir,'second'),'r');let store=await PublishedPrintFiles.open(root);
 for(const path of ['parts','parts/sub','other'])await store.mutateDirectory(path,false,signal());
 await store.publish('a','a.gcode',source,signal(),'parts/a.gcode');await store.publish('b','b.gcode',second,signal(),'parts/sub/b.gcode');await store.publish('survivor','outside.gcode',source,signal(),'other/outside.gcode');
 return {dir,root,source,get store(){return store;},async reopen(){await store.close();store=await PublishedPrintFiles.open(root);},async close(){await store.close();await source.close();await second.close();await rm(dir,{recursive:true,force:true});}};
}
test('recursive delete commits one directory event, preserves shared content and acquired sealed readers',async()=>{
 const f=await fixture(),events:any[]=[];const reader=await f.store.acquire('b',signal());
 try{
  f.store.observeDirectories(e=>events.push(e));const plan=await f.store.prepareDirectoryDelete('parts',signal());await f.store.deleteDirectory(plan,signal());
  assert.deepEqual(events,[{action:'delete_dir',path:'parts',modified:0}]);assert.equal(await f.store.hasDirectory('parts',signal()),false);assert.deepEqual((await f.store.catalog(signal())).map(e=>e.file.id),['survivor']);assert.equal((await f.store.readBytes('survivor',signal())).bytes.toString(),'G1 X1\n');
  const batch=await reader.next(signal());assert.equal(batch!.script,'G1 X2');reader.commit(batch!);await reader.close();await f.reopen();assert.deepEqual((await f.store.catalog(signal())).map(e=>e.file.id),['survivor']);
  const charged=(await Promise.all((await readdir(f.root)).map(async name=>(await stat(join(f.root,name))).size))).reduce((a,b)=>a+b,0);assert.equal(f.store.status.storedBytes,charged);assert.equal(f.store.status.reservedBytes,0);assert.equal((await readdir(f.root)).filter(n=>n.endsWith('.gcode')).length,1);
 }finally{await reader.close();await f.close();}
});
test('delete admission rejects foreign plans, changed membership, root and cancellation before decision',async()=>{
 const f=await fixture(),other=await fixture();try{
  const plan=await f.store.prepareDirectoryDelete('parts',signal());await assert.rejects(other.store.deleteDirectory(plan,signal()),/another store/);await f.store.publish('late','late.gcode',f.source,signal(),'parts/late.gcode');await assert.rejects(f.store.deleteDirectory(plan,signal()),PublishedFileChangedError);
  assert.equal((await f.store.catalog(signal())).length,4);await assert.rejects(f.store.prepareDirectoryDelete('',signal()),/path/);await assert.rejects(f.store.prepareDirectoryDelete('missing',signal()),{code:'ENOENT'});
  const abort=new AbortController();abort.abort(Error('cancel before decision'));await assert.rejects(f.store.deleteDirectory(await f.store.prepareDirectoryDelete('parts',signal()),abort.signal),/cancel before decision/);assert(!(await readdir(f.root)).includes('.namespace-delete.json'));
 }finally{await f.close();await other.close();}
});
for(const phase of ['before-intent','intent','partial-receipts','catalog','journal-removed'] as const)test('directory deletion recovers the same decision after '+phase,async t=>{
 const f=await fixture(),events:any[]=[];try{
  const plan=await f.store.prepareDirectoryDelete('parts',signal());f.store.observeDirectories(e=>events.push(e));const prototype=Object.getPrototypeOf(f.source),original=prototype.sync;let roots=0;
  const injected=t.mock.method(prototype,'sync',async function(this:import('node:fs/promises').FileHandle){const path=await readlink('/proc/self/fd/'+this.fd),isRoot=path===f.root;if(isRoot)roots++;if(phase==='before-intent'&&path.startsWith(f.root+'/.delete-')||phase==='intent'&&isRoot&&roots===1||phase==='partial-receipts'&&isRoot&&roots===2||phase==='catalog'&&isRoot&&roots===4||phase==='journal-removed'&&isRoot&&roots===5)throw Error('injected '+phase);return original.call(this);});
  try{await assert.rejects(f.store.deleteDirectory(plan,signal()),e=>e instanceof PublishedDeleteCommitError&&e.phase===(phase==='before-intent'?'before-intent':'intent-published'));assert.equal(events.length,0);assert.equal(f.store.status.reservedBytes,0);if(phase!=='before-intent')assert(f.store.status.writeFault);}finally{injected.mock.restore();}
  await f.reopen();assert.equal(await f.store.hasDirectory('parts',signal()),phase==='before-intent');assert.equal((await f.store.catalog(signal())).length,phase==='before-intent'?3:1);assert.equal((await f.store.readBytes('survivor',signal())).bytes.toString(),'G1 X1\n');assert(!(await readdir(f.root)).some(n=>n.startsWith('.delete-')||n==='.namespace-delete.json'||n.startsWith('.directories-')));await f.reopen();assert.equal((await f.store.catalog(signal())).length,phase==='before-intent'?3:1);
 }finally{await f.close();}
});
test('cancellation after the durable delete decision cannot leave a partial namespace',async t=>{
 const f=await fixture(),abort=new AbortController();try{
  const plan=await f.store.prepareDirectoryDelete('parts',signal()),prototype=Object.getPrototypeOf(f.source),original=prototype.sync;let fired=false;
  const injected=t.mock.method(prototype,'sync',async function(this:import('node:fs/promises').FileHandle){if(!fired&&await readlink('/proc/self/fd/'+this.fd)===f.root){fired=true;abort.abort(Error('cancel after decision'));}return original.call(this);});
  try{await f.store.deleteDirectory(plan,abort.signal);}finally{injected.mock.restore();}assert(abort.signal.aborted);await f.reopen();assert.deepEqual((await f.store.catalog(signal())).map(e=>e.file.id),['survivor']);
 }finally{await f.close();}
});
test('omitted children and changed survivors refuse recovery before deleting any authority or temporary file',async()=>{
 for(const forged of ['omitted','survivor'] as const){const f=await fixture();try{
  const plan=await f.store.prepareDirectoryDelete('parts',signal()),intent=forged==='omitted'?{...plan,deleted:plan.deleted.slice(0,1)}:plan;validateDeleteIntent(intent);await f.store.close();
  await writeFile(join(f.root,'.namespace-delete.json'),JSON.stringify(intent),{mode:0o600});if(forged==='survivor'){const path=join(f.root,'survivor.json'),file=JSON.parse(await readFile(path,'utf8'));await chmod(path,0o600);await writeFile(path,JSON.stringify({...file,name:'changed.gcode'}));await chmod(path,0o400);}
  const garbage=join(f.root,'.delete-11111111-1111-1111-1111-111111111111');await writeFile(garbage,'preserve');const before=await readFile(join(f.root,'a.json'));await assert.rejects(PublishedPrintFiles.open(f.root),/membership|namespace changed/);assert.deepEqual(await readFile(join(f.root,'a.json')),before);assert.equal(await readFile(garbage,'utf8'),'preserve');assert((await readdir(f.root)).includes('.namespace-delete.json'));
 }finally{await f.close();}}
});
test('journal quota is reserved before any deletion and leaves every byte on refusal',async()=>{
 const f=await fixture();try{const charged=f.store.status.storedBytes;await f.store.close();const store=await PublishedPrintFiles.open(f.root,{maxStorageBytes:charged});try{await assert.rejects(store.deleteDirectory(await store.prepareDirectoryDelete('parts',signal()),signal()),/quota/);assert.equal((await store.catalog(signal())).length,3);assert.equal(store.status.reservedBytes,0);assert(!(await readdir(f.root)).includes('.namespace-delete.json'));}finally{await store.close();}}finally{await f.close();}
});
