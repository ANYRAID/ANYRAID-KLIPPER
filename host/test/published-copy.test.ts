import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,open,rm,readdir,stat,unlink,utimes,link} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PublishedPrintFiles,PublishedCopyCommitError,type PublishedFileChange} from '../src/storage/published-files.ts';
import {validateCopyIntent,recoverCopyRecords} from '../src/storage/namespace-copy.ts';
const signal=()=>new AbortController().signal;
async function fixture(tree=false){
 const dir=await mkdtemp(join(tmpdir(),'published-copy-')),root=join(dir,'files');await writeFile(join(dir,'source'),'G1 X1\n');await writeFile(join(dir,'old'),'G1 X9\n');
 const source=await open(join(dir,'source'),'r'),old=await open(join(dir,'old'),'r');let store=await PublishedPrintFiles.open(root);
 if(tree){await store.mutateDirectory('parts',false,signal());await store.mutateDirectory('parts/sub',false,signal());await store.mutateDirectory('parts/empty',false,signal());}
 await store.publish('source','source.gcode',source,signal(),tree?'parts/source.gcode':'source.gcode');if(tree)await store.publish('child','child.gcode',source,signal(),'parts/sub/child.gcode');
 await store.publish('old','target.gcode',old,signal(),'target.gcode');
 return {dir,root,source,get store(){return store;},async reopen(){await store.close();store=await PublishedPrintFiles.open(root);},async close(){await store.close();await source.close();await old.close();await rm(dir,{recursive:true,force:true});}};
}
async function charged(f:Awaited<ReturnType<typeof fixture>>){return (await Promise.all((await readdir(f.root)).map(async n=>(await stat(join(f.root,n))).size))).reduce((a,b)=>a+b,0);}
test('copy replaces destination identity durably while source and sealed old reader remain immutable',async()=>{
 const f=await fixture(),reader=await f.store.acquire('old',signal()),events:PublishedFileChange[]=[];try{
  const source=(await f.store.describe('source',signal())).file,before=f.store.status.storedBytes;f.store.observeChanges(e=>events.push(e));
  const plan=await f.store.prepareCopy('source.gcode','target.gcode',signal());assert.equal(plan.action,'modify_file');assert.equal(plan.replaced?.id,'old');assert.notEqual(plan.entries[0].created.id,'source');assert.notEqual(plan.entries[0].created.id,'old');
  await f.store.copy(plan,signal());const id=await f.store.resolvePath('target.gcode',signal());assert.equal(id,plan.entries[0].created.id);assert.deepEqual((await f.store.describe('source',signal())).file,source);await assert.rejects(f.store.inspect('old'),{code:'ENOENT'});
  assert.equal(events.length,1);assert.equal(events[0].action,'modify_file');assert(!events[0].sourceFile);assert.equal(events[0].file.id,id);assert.equal(f.store.status.reservedBytes,0);assert.equal(f.store.status.storedBytes,await charged(f));assert(f.store.status.storedBytes<before+2048);
  const batch=(await reader.next(signal()))!;assert.equal(batch.script,'G1 X9');reader.commit(batch);assert.equal(await reader.next(signal()),null);
  await f.reopen();assert.equal(await f.store.resolvePath('target.gcode',signal()),id);assert.equal(f.store.status.storedBytes,await charged(f));assert.equal((await f.store.readBytes(id,signal())).bytes.toString(),'G1 X1\n');
 }finally{await reader.close();await f.close();}
});
test('file copy resolves a directory basename and tree copy preserves empty children and creates ancestors',async()=>{
 const f=await fixture(true);try{
  await f.store.mutateDirectory('target',false,signal());await f.store.copy(await f.store.prepareCopy('parts/source.gcode','target',signal()),signal());assert.notEqual(await f.store.resolvePath('target/source.gcode',signal()),'source');
  const plan=await f.store.prepareCopy('parts','new/parent/copy',signal());assert.equal(plan.entries.length,2);await f.store.copy(plan,signal());assert(await f.store.hasDirectory('new/parent/copy/empty',signal()));assert(await f.store.hasDirectory('parts/sub',signal()));
  for(const entry of plan.entries){assert.equal((await f.store.describe(entry.created.id,signal())).file.sha256,entry.source.sha256);assert(Math.abs((await f.store.describe(entry.created.id,signal())).modified-entry.modified)<1e-6);}
  await assert.rejects(f.store.prepareCopy('parts','target',signal()),{code:'EEXIST'});await assert.rejects(f.store.prepareCopy('parts','parts/sub/copy',signal()),{code:'EINVAL'});await assert.rejects(f.store.prepareCopy('parts/source.gcode','missing/file.gcode',signal()),{code:'ENOENT'});
  await f.reopen();assert(await f.store.hasDirectory('new/parent/copy/empty',signal()));assert.equal(f.store.status.storedBytes,await charged(f));
 }finally{await f.close();}
});
test('copy plans reject changed membership, foreign owners and pre-intent cancellation',async()=>{
 const f=await fixture(true),other=await fixture(true);try{
  const plan=await f.store.prepareCopy('parts','copy',signal());await assert.rejects(other.store.copy(plan,signal()),/another store/);
  await f.store.publish('late','late',f.source,signal(),'parts/late.gcode');await assert.rejects(f.store.copy(plan,signal()));assert.equal(await f.store.hasDirectory('copy',signal()),false);
  const next=await f.store.prepareCopy('parts','copy',signal()),a=new AbortController();a.abort(new Error('cancel copy'));await assert.rejects(f.store.copy(next,a.signal),/cancel copy/);assert.equal(f.store.status.reservedBytes,0);assert(!(await readdir(f.root)).includes('.namespace-copy.json'));
 }finally{await f.close();await other.close();}
});
for(const tree of [false,true])for(const prefix of [0,1,2])test(`copy restart completes permitted partial prefix (tree=${tree}, prefix=${prefix})`,async()=>{
 const f=await fixture(tree);try{
  const plan=await f.store.prepareCopy(tree?'parts':'source.gcode',tree?'copy':'target.gcode',signal());assert.deepEqual(validateCopyIntent(JSON.parse(JSON.stringify(plan))),plan);await f.store.close();
  await writeFile(join(f.root,'.namespace-copy.json'),JSON.stringify(plan),{mode:0o600});
  if(prefix>=1){const entry=plan.entries[0];await writeFile(join(f.root,entry.created.id+'.json'),JSON.stringify(entry.created),{mode:0o400});await utimes(join(f.root,entry.created.id+'.json'),entry.modified,entry.modified);}
  if(prefix>=2){if(plan.replaced)await unlink(join(f.root,plan.replaced.id+'.json'));else await writeFile(join(f.root,'.directories.json'),JSON.stringify({version:1,directories:plan.directoriesAfter}),{mode:0o600});}
  await f.reopen();assert.equal((await readdir(f.root)).includes('.namespace-copy.json'),false);for(const entry of plan.entries){assert.equal(await f.store.resolvePath(entry.created.path!,signal()),entry.created.id);assert.equal((await f.store.readBytes(entry.created.id,signal())).bytes.toString(),'G1 X1\n');}
  await f.reopen();assert.equal(f.store.status.storedBytes,await charged(f));assert.equal(await f.store.resolvePath(tree?'parts/source.gcode':'source.gcode',signal()),'source');
 }finally{await f.close();}
});
test('failed intent sync reports uncertainty and recovers without publishing notifications',async t=>{
 const f=await fixture(),events:PublishedFileChange[]=[];try{
  const plan=await f.store.prepareCopy('source.gcode','target.gcode',signal());f.store.observeChanges(e=>events.push(e));const proto=Object.getPrototypeOf(f.source),original=proto.sync;
  const injection=t.mock.method(proto,'sync',async function(this:import('node:fs/promises').FileHandle){if((await this.stat()).isDirectory())throw new Error('copy intent sync fault');return original.call(this);});
  try{await assert.rejects(f.store.copy(plan,signal()),e=>e instanceof PublishedCopyCommitError&&e.phase==='intent-published');assert(f.store.status.writeFault);assert.equal(events.length,0);await assert.rejects(f.store.resolvePath('source.gcode',signal()),/requires recovery/);}finally{injection.mock.restore();}
  await f.reopen();assert.equal(await f.store.resolvePath('target.gcode',signal()),plan.entries[0].created.id);assert.equal(f.store.status.reservedBytes,0);
 }finally{await f.close();}
});
test('copy recovery cleans its linked receipt temporary without touching the new or source receipt',async()=>{
 const f=await fixture();try{
  const plan=await f.store.prepareCopy('source.gcode','target.gcode',signal()),entry=plan.entries[0],temp='.receipt-00000000-0000-4000-8000-000000000001';await f.store.close();
  await writeFile(join(f.root,'.namespace-copy.json'),JSON.stringify(plan),{mode:0o600});await writeFile(join(f.root,temp),JSON.stringify(entry.created),{mode:0o400});await utimes(join(f.root,temp),entry.modified,entry.modified);await link(join(f.root,temp),join(f.root,entry.created.id+'.json'));
  assert.equal((await stat(join(f.root,entry.created.id+'.json'))).nlink,2);await f.reopen();assert.equal((await stat(join(f.root,entry.created.id+'.json'))).nlink,1);assert(!(await readdir(f.root)).includes(temp));assert.equal(await f.store.resolvePath('target.gcode',signal()),entry.created.id);assert.equal(await f.store.resolvePath('source.gcode',signal()),'source');assert.equal(f.store.status.storedBytes,await charged(f));
 }finally{await f.close();}
});
test('recovery rejects omitted source children or tampered new identity before changing disk',async()=>{
 const f=await fixture(true);try{
  const plan=await f.store.prepareCopy('parts','copy',signal()),files=(await f.store.catalog(signal())).map(r=>r.file);assert.throws(()=>recoverCopyRecords(plan,[...files,{...files[0],id:'unexpected',path:'parts/new.gcode'}],new Map(plan.directoriesBefore.map(d=>[d.path,d.modified]))));
  const bad=JSON.parse(JSON.stringify(plan));bad.entries[0].created.id=bad.entries[0].source.id;assert.throws(()=>validateCopyIntent(bad));
  await f.store.publish('late','late',f.source,signal(),'parts/late.gcode');await f.store.close();await writeFile(join(f.root,'.namespace-copy.json'),JSON.stringify(plan),{mode:0o600});const before=await readFile(join(f.root,'.namespace-copy.json'));await assert.rejects(f.reopen(),/identity collision|membership|Invalid copy/);assert.deepEqual(await readFile(join(f.root,'.namespace-copy.json')),before);assert(!(await readdir(f.root)).some(n=>plan.entries.some(e=>n===e.created.id+'.json')));
 }finally{await f.close();}
});
