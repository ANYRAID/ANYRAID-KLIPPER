import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,open,rm,readdir,stat,unlink,utimes,readlink,rename,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PublishedPrintFiles,PublishedReplacementCommitError,type PublishedFileChange} from '../src/storage/published-files.ts';
import {validateReplacementIntent,type FileReplacement} from '../src/storage/namespace-replace.ts';
const signal=()=>new AbortController().signal;
async function fixture(shared=false){
 const dir=await mkdtemp(join(tmpdir(),'published-replace-')),root=join(dir,'files');await writeFile(join(dir,'source'),'G1 X1\n');await writeFile(join(dir,'old'),shared?'G1 X1\n':'G1 X9\n');
 const source=await open(join(dir,'source'),'r'),old=await open(join(dir,'old'),'r');let store=await PublishedPrintFiles.open(root,{maxPublishedFiles:2});
 await store.publish('source','source.gcode',source,signal(),'source.gcode');await store.publish('old','target.gcode',old,signal(),'target.gcode');
 return {dir,root,source,get store(){return store;},async reopen(options:Parameters<typeof PublishedPrintFiles.open>[1]={maxPublishedFiles:2}){await store.close();store=await PublishedPrintFiles.open(root,options);},async close(){await store.close();await source.close();await old.close();await rm(dir,{recursive:true,force:true});}};
}
async function charged(root:string){return (await Promise.all((await readdir(root)).map(async n=>(await stat(join(root,n))).size))).reduce((a,b)=>a+b,0);}
async function image(root:string){return Promise.all((await readdir(root)).sort().map(async n=>[n,(await readFile(join(root,n))).toString('hex')]));}
for(const shared of [false,true])for(const move of [false,true])test(`replacement retains immutable identities/readers and exact capacity (move=${move}, shared=${shared})`,async()=>{
 const f=await fixture(shared),reader=await f.store.acquire('old',signal()),events:PublishedFileChange[]=[];
 try{
  const original=await f.store.describe('source',signal());f.store.observeChanges(e=>events.push(e));
  if(move){const plan=await f.store.prepareFileMove('source.gcode','target.gcode',signal());assert.equal(plan.replaced?.id,'old');await f.store.moveFile(plan,signal());await assert.rejects(f.store.resolvePath('source.gcode',signal()),{code:'ENOENT'});}
  else{const plan=await f.store.prepareUploadReplacement('new','target.gcode','target.gcode',signal());await f.store.replaceUpload(plan,f.source,signal());assert.deepEqual((await f.store.describe('source',signal())).file,original.file);}
  const id=move?'source':'new';assert.equal(await f.store.resolvePath('target.gcode',signal()),id);await assert.rejects(f.store.inspect('old'),{code:'ENOENT'});
  assert.equal(events.length,1);assert.equal(events[0].action,move?'move_file':'create_file');assert.equal(events[0].sourceFile?.id,move?'source':undefined);
  assert.equal(f.store.status.publishedFiles,move?1:2);assert.equal(f.store.status.reservedBytes,0);assert.equal(f.store.status.storedBytes,await charged(f.root));
  if(move)assert(Math.abs((await f.store.describe(id,signal())).modified-original.modified)<1e-6);
  const batch=(await reader.next(signal()))!;assert.equal(batch.script,shared?'G1 X1':'G1 X9');reader.commit(batch);assert.equal(await reader.next(signal()),null);
  for(let n=0;n<2;n++){await f.reopen();assert.equal(await f.store.resolvePath('target.gcode',signal()),id);assert.equal((await f.store.readBytes(id,signal())).bytes.toString(),'G1 X1\n');assert.equal(f.store.status.storedBytes,await charged(f.root));}
 }finally{await reader.close();await f.close();}
});
test('upload replacement rejects a reused ID, foreign plan, changed namespace and peak byte quota without effects',async()=>{
 const f=await fixture(),foreign=await fixture();try{
  await assert.rejects(f.store.prepareUploadReplacement('source','target.gcode','target.gcode',signal()),{code:'EEXIST'});
  const plan=await f.store.prepareUploadReplacement('new','target.gcode','target.gcode',signal());await assert.rejects(foreign.store.replaceUpload(plan,foreign.source,signal()),/another store/);
  await f.store.mutateDirectory('late',false,signal());const before=await image(f.root);await assert.rejects(f.store.replaceUpload(plan,f.source,signal()));assert.deepEqual(await image(f.root),before);assert.equal(f.store.status.reservedBytes,0);
  const used=f.store.status.storedBytes;await f.reopen({maxStorageBytes:used+1,maxPublishedFiles:2});const limited=await f.store.prepareUploadReplacement('new','target.gcode','target.gcode',signal());await assert.rejects(f.store.replaceUpload(limited,f.source,signal()),/quota/);assert.equal(await f.store.resolvePath('target.gcode',signal()),'old');assert.equal(f.store.status.storedBytes,used);assert.equal(f.store.status.reservedBytes,0);
 }finally{await f.close();await foreign.close();}
});
async function intent(f:Awaited<ReturnType<typeof fixture>>,move:boolean):Promise<FileReplacement>{
 const prepared=await f.store.prepareUploadReplacement('new','target.gcode','target.gcode',signal()),source=await f.store.describe('source',signal());
 return validateReplacementIntent({version:1,action:move?'move_file':'create_file',created:{...source.file,id:move?'source':'new',name:'target.gcode',path:'target.gcode'},replaced:prepared.replaced,...move?{source:source.file}:{},modified:source.modified,namespaceSha256:prepared.namespaceSha256,directories:prepared.directories});
}
for(const move of [false,true])for(const prefix of [0,1,2])test(`replacement reopens twice from durable ordered prefix (move=${move}, prefix=${prefix})`,async()=>{
 const f=await fixture();try{
  const plan=await intent(f,move);await f.store.close();await writeFile(join(f.root,'.namespace-replace.json'),JSON.stringify(plan),{mode:0o600});
  if(prefix>=1){const temp=join(f.root,'.receipt-00000000-0000-4000-8000-000000000001');await writeFile(temp,JSON.stringify(plan.created),{mode:0o400});await utimes(temp,plan.modified,plan.modified);await rename(temp,join(f.root,plan.created.id+'.json'));}
  if(prefix>=2)await unlink(join(f.root,'old.json'));
  await f.reopen();assert.equal(await f.store.resolvePath('target.gcode',signal()),plan.created.id);await assert.rejects(f.store.inspect('old'),{code:'ENOENT'});assert(!(await readdir(f.root)).includes('.namespace-replace.json'));
  await f.reopen();assert.equal(f.store.status.storedBytes,await charged(f.root));assert.equal(f.store.status.reservedBytes,0);
 }finally{await f.close();}
});
for(const defect of ['impossible-prefix','new-member','content-corrupt','unknown-key','wrong-action','wrong-namespace'] as const)test(`replacement recovery rejects ${defect} before any disk changes`,async()=>{
 const f=await fixture();try{
  const plan=await intent(f,false),raw=JSON.parse(JSON.stringify(plan));await f.store.close();
  if(defect==='impossible-prefix')await unlink(join(f.root,'old.json'));
  if(defect==='new-member')await writeFile(join(f.root,'unexpected.json'),JSON.stringify({...plan.created,id:'unexpected',path:'unexpected.gcode',name:'unexpected.gcode'}),{mode:0o400});
  if(defect==='content-corrupt'){await chmod(join(f.root,plan.created.sha256+'.gcode'),0o600);await writeFile(join(f.root,plan.created.sha256+'.gcode'),'G1 X2\n');}
  if(defect==='unknown-key')raw.unknown=true;if(defect==='wrong-action')raw.action='delete_file';if(defect==='wrong-namespace')raw.namespaceSha256='0'.repeat(64);
  await writeFile(join(f.root,'.namespace-replace.json'),JSON.stringify(raw),{mode:0o600});const before=await image(f.root);await assert.rejects(f.reopen());assert.deepEqual(await image(f.root),before);
 }finally{await f.close();}
});
for(const decided of [false,true])test(`upload cancellation ${decided?'after':'before'} durable decision preserves its specified outcome`,async t=>{
 const f=await fixture(),controller=new AbortController(),events:PublishedFileChange[]=[];try{
  const plan=await f.store.prepareUploadReplacement('new','target.gcode','target.gcode',signal());f.store.observeChanges(e=>events.push(e));const proto=Object.getPrototypeOf(f.source),original=proto.sync;
  const injection=t.mock.method(proto,'sync',async function(this:import('node:fs/promises').FileHandle){await original.call(this);const name=await readlink('/proc/self/fd/'+this.fd);if(!decided&&/\/\.replace-/.test(name)||decided&&(await this.stat()).isDirectory()&&(await readdir(f.root)).includes('.namespace-replace.json'))controller.abort(new Error('cancel replacement'));});
  try{if(decided)await f.store.replaceUpload(plan,f.source,controller.signal);else await assert.rejects(f.store.replaceUpload(plan,f.source,controller.signal),e=>e instanceof PublishedReplacementCommitError&&e.phase==='before-intent');}finally{injection.mock.restore();}
  assert.equal(await f.store.resolvePath('target.gcode',signal()),decided?'new':'old');assert.equal(events.length,decided?1:0);assert.equal(f.store.status.reservedBytes,0);assert.equal(f.store.status.storedBytes,await charged(f.root));
  for(let n=0;n<2;n++){await f.reopen();assert.equal(await f.store.resolvePath('target.gcode',signal()),decided?'new':'old');}
 }finally{await f.close();}
});
test('failed replacement intent sync fences reads and recovers without a duplicate notification',async t=>{
 const f=await fixture(),events:PublishedFileChange[]=[];try{
  const plan=await f.store.prepareUploadReplacement('new','target.gcode','target.gcode',signal());f.store.observeChanges(e=>events.push(e));const proto=Object.getPrototypeOf(f.source),original=proto.sync;let injected=false;
  const injection=t.mock.method(proto,'sync',async function(this:import('node:fs/promises').FileHandle){if(!injected&&(await this.stat()).isDirectory()&&(await readdir(f.root)).includes('.namespace-replace.json')){injected=true;throw new Error('intent sync fault');}await original.call(this);});
  try{await assert.rejects(f.store.replaceUpload(plan,f.source,signal()),e=>e instanceof PublishedReplacementCommitError&&e.phase==='intent-published');assert(f.store.status.writeFault);assert.equal(events.length,0);await assert.rejects(f.store.catalog(signal()),/requires recovery/);}finally{injection.mock.restore();}
  await f.reopen();assert.equal(await f.store.resolvePath('target.gcode',signal()),'new');await f.reopen();assert.equal(f.store.status.storedBytes,await charged(f.root));assert.equal(events.length,0);
 }finally{await f.close();}
});
