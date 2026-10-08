import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,open,writeFile,readFile,readlink,readdir,rm,type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/a7fUAAAAASUVORK5CYII=','base64');
const signal=()=>new AbortController().signal;
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'published-paired-')),root=join(directory,'files'),modelPath=join(directory,'model'),previewPath=join(directory,'preview');await writeFile(modelPath,'G1 X1\n');await writeFile(previewPath,png);
 const model=await open(modelPath,'r'),preview=await open(previewPath,'r'),store=await PublishedPrintFiles.open(root,{maxOperations:1});
 return {directory,root,modelPath,previewPath,model,preview,store,async close(){await store.close();await model.close();await preview.close();await rm(directory,{recursive:true,force:true});}};
}
async function interceptSync(run:(kind:string,original:()=>Promise<void>)=>Promise<void>){
 const handle=await open('/dev/null','r'),prototype=Object.getPrototypeOf(handle) as FileHandle,original=prototype.sync;await handle.close();
 prototype.sync=async function(){const path=await readlink('/proc/self/fd/'+this.fd),base=path.slice(path.lastIndexOf('/')+1),kind=base.startsWith('.upload-')?'model':base.startsWith('.preview-')?'preview':base.startsWith('.receipt-')?'receipt':'directory';return run(kind,()=>original.call(this));};
 return ()=>{prototype.sync=original;};
}
function pausedPreview(f:Awaited<ReturnType<typeof fixture>>,entered:ReturnType<typeof Promise.withResolvers<void>>,release:ReturnType<typeof Promise.withResolvers<void>>):FileHandle{
 return {stat:()=>f.preview.stat({bigint:true}),read:async(buffer:Buffer,offset:number,length:number,position:number)=>{if(length>8){entered.resolve();await release.promise;}return f.preview.read(buffer,offset,length,position);}} as unknown as FileHandle;
}
test('paired content syncs overlap while both directory barriers and receipt sync remain ordered',{timeout:10000},async()=>{
 const f=await fixture(),model=Promise.withResolvers<void>(),preview=Promise.withResolvers<void>(),events:string[]=[];
 const restore=await interceptSync(async(kind,original)=>{events.push(kind+'-start');if(kind==='model'){model.resolve();await preview.promise;}if(kind==='preview'){preview.resolve();await model.promise;}await original();events.push(kind+'-done');});
 try{
  const record=await f.store.publish('job','零件.gcode',f.model,signal(),undefined,f.preview);
  assert.equal(events.filter(x=>x.endsWith('-start')).length,5);const firstDirectory=events.indexOf('directory-start');assert(firstDirectory>events.indexOf('model-done'));assert(firstDirectory>events.indexOf('preview-done'));assert(events.indexOf('receipt-start')>firstDirectory);assert.equal(events.at(-2),'directory-start');assert.equal(events.at(-1),'directory-done');
  assert.equal(record.sha256,createHash('sha256').update('G1 X1\n').digest('hex'));assert.equal(record.preview?.sha256,createHash('sha256').update(png).digest('hex'));assert.deepEqual((await f.store.readPreview('job',signal()))?.bytes,png);assert.equal(f.store.status.reservedBytes,0);
  await f.store.close();const next=await PublishedPrintFiles.open(f.root);try{assert.deepEqual(await next.inspect('job'),record);}finally{await next.close();}
 }finally{model.resolve();preview.resolve();restore();await f.close();}
});
test('model failure and close drain a preview still reading before releasing publication ownership',{timeout:10000},async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),modelFailed=Promise.withResolvers<void>();let settled=false,closed=false,notifications=0;
 const restore=await interceptSync(async(kind,original)=>{if(kind==='model'){modelFailed.resolve();throw new Error('paired model sync fault');}await original();});
 try{
  f.store.observeChanges(()=>notifications++);const publication=f.store.publish('job','file',f.model,signal(),undefined,pausedPreview(f,entered,release));const rejected=assert.rejects(publication,/paired model sync fault/).then(()=>{settled=true;});await Promise.all([entered.promise,modelFailed.promise]);
  const closing=f.store.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);assert.equal(closed,false);assert(f.store.status.reservedBytes>0);assert(!(await readdir(f.root)).includes('job.json'));
  release.resolve();await rejected;await closing;assert.equal(notifications,0);assert.equal(f.store.status.reservedBytes,0);
  const next=await PublishedPrintFiles.open(f.root);try{assert.deepEqual(await readdir(f.root),[]);assert.equal(next.status.storedBytes,0);}finally{await next.close();}
 }finally{release.resolve();restore();await f.close();}
});
test('preview failure drains a model still syncing and never publishes a receipt',{timeout:10000},async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),previewFailed=Promise.withResolvers<void>();let settled=false;
 const restore=await interceptSync(async(kind,original)=>{if(kind==='model'){entered.resolve();await release.promise;}if(kind==='preview'){previewFailed.resolve();throw new Error('paired preview sync fault');}await original();});
 try{
  const publication=f.store.publish('job','file',f.model,signal(),undefined,f.preview),rejected=assert.rejects(publication,/paired preview sync fault/).then(()=>{settled=true;});await Promise.all([entered.promise,previewFailed.promise]);await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);assert(!(await readdir(f.root)).includes('job.json'));release.resolve();await rejected;assert.equal(f.store.status.reservedBytes,0);await f.store.close();
  const next=await PublishedPrintFiles.open(f.root);try{assert.deepEqual(await readdir(f.root),[]);}finally{await next.close();}
 }finally{release.resolve();restore();await f.close();}
});
test('cancellation drains both content branches, retains admission bound and emits no publication',{timeout:10000},async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),modelSynced=Promise.withResolvers<void>(),controller=new AbortController();let closed=false,settled=false,notifications=0;
 const restore=await interceptSync(async(kind,original)=>{await original();if(kind==='model')modelSynced.resolve();});
 try{
  f.store.observeChanges(()=>notifications++);const publication=f.store.publish('job','file',f.model,controller.signal,undefined,pausedPreview(f,entered,release)),rejected=assert.rejects(publication,error=>error===controller.signal.reason).then(()=>{settled=true;});await Promise.all([entered.promise,modelSynced.promise]);await assert.rejects(f.store.publish('second','file',f.model,signal(),undefined,f.preview),/limit/);controller.abort();const closing=f.store.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);assert.equal(settled,false);release.resolve();await rejected;await closing;assert.equal(notifications,0);assert.equal(f.store.status.reservedBytes,0);
  const next=await PublishedPrintFiles.open(f.root);try{assert.deepEqual(await readdir(f.root),[]);}finally{await next.close();}
 }finally{release.resolve();restore();await f.close();}
});
test('two preparation failures are retained after both branches drain',{timeout:10000},async()=>{
 const f=await fixture(),model=Promise.withResolvers<void>(),preview=Promise.withResolvers<void>();
 const restore=await interceptSync(async(kind,original)=>{if(kind==='model'){model.resolve();await preview.promise;throw new Error('model fault');}if(kind==='preview'){preview.resolve();await model.promise;throw new Error('preview fault');}await original();});
 try{await assert.rejects(f.store.publish('job','file',f.model,signal(),undefined,f.preview),error=>{assert(error instanceof AggregateError);assert.deepEqual(error.errors.map(x=>(x as Error).message),['model fault','preview fault']);return true;});assert.equal(f.store.status.reservedBytes,0);assert.deepEqual(await readdir(f.root),[]);}finally{model.resolve();preview.resolve();restore();await f.close();}
});
test('same bytes reuse the original model and preview blobs without leaking temporary quota',async()=>{
 const f=await fixture();try{const one=await f.store.publish('one','file',f.model,signal(),undefined,f.preview),two=await f.store.publish('two','file',f.model,signal(),undefined,f.preview);assert.equal(one.sha256,two.sha256);assert.deepEqual(one.preview,two.preview);assert.equal(f.store.status.reservedBytes,0);assert.deepEqual((await readdir(f.root)).sort(),[one.sha256+'.gcode',one.preview!.sha256+'.png','one.json','two.json'].sort());assert.deepEqual(await readFile(join(f.root,one.preview!.sha256+'.png')),png);}finally{await f.close();}
});
test('SIGKILL during one pending content sync preserves old receipts and recovers bounded orphans',{timeout:15000},async()=>{
 const f=await fixture();let child:ReturnType<typeof spawn>|undefined,exited:Promise<unknown>|undefined;
 try{
  const previous=await f.store.publish('previous','file',f.model,signal(),undefined,f.preview);await f.store.close();await writeFile(f.modelPath,'G1 X2\n');const different=Buffer.from(png);different[different.length-1]^=1;await writeFile(f.previewPath,different);
  const module=new URL('../src/storage/published-files.'+(import.meta.url.endsWith('.js')?'js':'ts'),import.meta.url).href;
  const script=`import {open,readlink} from 'node:fs/promises';import {PublishedPrintFiles} from ${JSON.stringify(module)};process.on('message',()=>{});const model=await open(process.argv[2],'r'),preview=await open(process.argv[3],'r'),proto=Object.getPrototypeOf(model),sync=proto.sync;proto.sync=async function(){const path=await readlink('/proc/self/fd/'+this.fd);if(path.includes('/.upload-')){await sync.call(this);process.send('model-sync-pending');await new Promise(()=>{});}return sync.call(this);};const store=await PublishedPrintFiles.open(process.argv[1]);await store.publish('interrupted','file',model,new AbortController().signal,undefined,preview);throw Error('must not acknowledge');`;
  child=spawn(process.execPath,['--input-type=module','-e',script,f.root,f.modelPath,f.previewPath],{stdio:['ignore','ignore','pipe','ipc']});let stderr='';child.stderr!.on('data',chunk=>stderr+=chunk);exited=once(child,'exit');await Promise.race([once(child,'message',{signal:AbortSignal.timeout(10000)}).then(([message])=>assert.equal(message,'model-sync-pending')),exited.then(()=>{throw new Error('early child exit: '+stderr);})]);assert(!(await readdir(f.root)).includes('interrupted.json'));assert(child.kill('SIGKILL'));await exited;assert.equal(child.signalCode,'SIGKILL');
  const next=await PublishedPrintFiles.open(f.root);try{assert.deepEqual(await next.inspect('previous'),previous);await assert.rejects(next.inspect('interrupted'),{code:'ENOENT'});assert.equal(next.status.reservedBytes,0);assert.deepEqual((await readdir(f.root)).sort(),[previous.sha256+'.gcode',previous.preview!.sha256+'.png','previous.json'].sort());await next.publish('retry','file',f.model,signal(),undefined,f.preview);}finally{await next.close();}
 }finally{if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;await f.close();}
});
