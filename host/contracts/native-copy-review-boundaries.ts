// Explicit bounded review experiment; ordinary regression totals are recorded separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,open,writeFile,rm,readdir,stat,access} from 'node:fs/promises';
import {join} from 'node:path';
import {PublishedPrintFiles,PublishedCopyCommitError} from '../src/storage/published-files.ts';
const signal=()=>new AbortController().signal;
async function fixture(){
 const scratch=join(import.meta.dirname,'../build/review-copy-58');await mkdir(scratch,{recursive:true});
 const dir=await mkdtemp(join(scratch,'case-')),root=join(dir,'files');
 await writeFile(join(dir,'source'),'G1 X1\n');await writeFile(join(dir,'old'),'G1 X9\n');
 const source=await open(join(dir,'source'),'r'),old=await open(join(dir,'old'),'r');
 let store=await PublishedPrintFiles.open(root,{maxPublishedFiles:2,maxStorageBytes:8192});
 await store.publish('source','source.gcode',source,signal(),'source.gcode');
 await store.publish('old','target.gcode',old,signal(),'target.gcode');
 return {dir,root,source,get store(){return store;},async reopen(maxStorageBytes=8192){await store.close();store=await PublishedPrintFiles.open(root,{maxPublishedFiles:2,maxStorageBytes});},async close(){await store.close();await source.close();await old.close();await rm(dir,{recursive:true,force:true});}};
}
async function charge(root:string){return (await Promise.all((await readdir(root)).map(async name=>(await stat(join(root,name))).size))).reduce((a,b)=>a+b,0);}
test('full file-count capacity permits overwrite, then rejects a fresh copy without effects',async()=>{
 const f=await fixture(),events:any[]=[];f.store.observeChanges(e=>events.push(e));try{
  const plan=await f.store.prepareCopy('source.gcode','target.gcode',signal());await f.store.copy(plan,signal());
  const target=await f.store.resolvePath('target.gcode',signal());assert.equal(target,plan.entries[0].created.id);assert.equal(f.store.status.publishedFiles,2);assert.equal(events.length,1);
  const third=await f.store.prepareCopy('source.gcode','third.gcode',signal());await assert.rejects(f.store.copy(third,signal()),/file quota/);
  assert.equal(events.length,1);assert.equal(await f.store.resolvePath('target.gcode',signal()),target);assert.equal(f.store.filename('source'),'source.gcode');assert.equal(f.store.status.reservedBytes,0);assert.equal(f.store.status.storedBytes,await charge(f.root));assert.equal(f.store.status.writeFault,undefined);
  await f.reopen();assert.equal(await f.store.resolvePath('target.gcode',signal()),target);assert.equal(f.store.status.storedBytes,await charge(f.root));
 }finally{await f.close();}
});
test('peak byte quota rejects overwrite before intent without losing the old target',async()=>{
 const f=await fixture();try{
  const used=await charge(f.root);await f.reopen(used+1);const events:any[]=[];f.store.observeChanges(e=>events.push(e));
  await assert.rejects(f.store.copy(await f.store.prepareCopy('source.gcode','target.gcode',signal()),signal()),/storage quota/);
  assert.equal(await f.store.resolvePath('target.gcode',signal()),'old');assert.equal((await f.store.readBytes('old',signal())).bytes.toString(),'G1 X9\n');assert.equal(events.length,0);assert.equal(f.store.status.reservedBytes,0);assert.equal(f.store.status.writeFault,undefined);assert(!(await readdir(f.root)).includes('.namespace-copy.json'));assert.equal(f.store.status.storedBytes,used);
  await f.reopen();assert.equal(await f.store.resolvePath('target.gcode',signal()),'old');assert.equal(f.store.status.storedBytes,await charge(f.root));
 }finally{await f.close();}
});
test('cancellation after journal staging but before intent retains old target with no event',async t=>{
 const f=await fixture(),controller=new AbortController(),events:any[]=[];f.store.observeChanges(e=>events.push(e));try{
  const plan=await f.store.prepareCopy('source.gcode','target.gcode',signal()),proto=Object.getPrototypeOf(f.source),original=proto.sync;let staged=false;
  const injection=t.mock.method(proto,'sync',async function(this:import('node:fs/promises').FileHandle){if(!staged&&(await this.stat()).isFile()){staged=true;controller.abort(new Error('cancel before intent'));}return original.call(this);});
  try{await assert.rejects(f.store.copy(plan,controller.signal),e=>e instanceof PublishedCopyCommitError&&e.phase==='before-intent');}finally{injection.mock.restore();}
  assert(staged);assert.equal(await f.store.resolvePath('target.gcode',signal()),'old');assert.equal(events.length,0);assert.equal(f.store.status.reservedBytes,0);assert.equal(f.store.status.writeFault,undefined);assert(!(await readdir(f.root)).some(n=>n.startsWith('.copy-')||n==='.namespace-copy.json'));await f.reopen();assert.equal(await f.store.resolvePath('target.gcode',signal()),'old');
 }finally{await f.close();}
});
test('cancellation after durable intent completes overwrite and preserves an old sealed reader',async t=>{
 const f=await fixture(),controller=new AbortController(),events:any[]=[];f.store.observeChanges(e=>events.push(e));const reader=await f.store.acquire('old',signal());try{
  const plan=await f.store.prepareCopy('source.gcode','target.gcode',signal()),proto=Object.getPrototypeOf(f.source),original=proto.sync;let decided=false;
  const injection=t.mock.method(proto,'sync',async function(this:import('node:fs/promises').FileHandle){const result=await original.call(this);if(!decided&&(await this.stat()).isDirectory()){try{await access(join(f.root,'.namespace-copy.json'));decided=true;controller.abort(new Error('cancel after durable intent'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}return result;});
  try{await f.store.copy(plan,controller.signal);}finally{injection.mock.restore();}
  assert(decided);assert(controller.signal.aborted);assert.equal(await f.store.resolvePath('target.gcode',signal()),plan.entries[0].created.id);await assert.rejects(f.store.inspect('old'),{code:'ENOENT'});assert.equal(events.length,1);assert.equal(events[0].action,'modify_file');assert.equal(f.store.status.reservedBytes,0);assert.equal(f.store.status.writeFault,undefined);assert.equal(f.store.status.storedBytes,await charge(f.root));
  const batch=(await reader.next(signal()))!;assert.equal(batch.script,'G1 X9');reader.commit(batch);assert.equal(await reader.next(signal()),null);await f.reopen();assert.equal(await f.store.resolvePath('target.gcode',signal()),plan.entries[0].created.id);assert.equal(events.length,1);assert.equal(f.store.status.storedBytes,await charge(f.root));await f.reopen();assert.equal(await f.store.resolvePath('target.gcode',signal()),plan.entries[0].created.id);
 }finally{await reader.close();await f.close();}
});
