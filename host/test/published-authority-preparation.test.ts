import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,open,writeFile,readlink,readdir,rm,type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {externalAcceptanceBundle,assertAcceptanceBundleUnchanged} from './helpers/acceptance-bundle.ts';
const retained=await externalAcceptanceBundle();if(retained)after(()=>assertAcceptanceBundleUnchanged(retained));
const moduleUrl=retained?pathToFileURL(join(retained.path,'host/src/storage/published-files.js')).href:new URL('../src/storage/published-files.'+(import.meta.url.endsWith('.js')?'js':'ts'),import.meta.url).href;
const {PublishedPrintFiles}=await import(moduleUrl) as typeof import('../src/storage/published-files.ts');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/a7fUAAAAASUVORK5CYII=','base64');
const signal=()=>new AbortController().signal;
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'published-authority-')),root=join(directory,'files'),modelPath=join(directory,'model'),previewPath=join(directory,'preview');await writeFile(modelPath,'G1 X1\n');await writeFile(previewPath,png);
 const model=await open(modelPath,'r'),preview=await open(previewPath,'r'),store=await PublishedPrintFiles.open(root,{maxOperations:1});
 return {directory,root,modelPath,previewPath,model,preview,store,publish:(id='job',s=signal())=>store.publish(id,id+'.gcode',model,s,undefined,preview),async close(){await store.close();await model.close();await preview.close();await rm(directory,{recursive:true,force:true});}};
}
async function interceptSync(f:Awaited<ReturnType<typeof fixture>>,run:(kind:string,original:()=>Promise<void>)=>Promise<void>){
 const prototype=Object.getPrototypeOf(f.model) as FileHandle,previous=prototype.sync;
 prototype.sync=async function(){const path=await readlink('/proc/self/fd/'+this.fd);return run(path===f.root?'directory':path.includes('/.receipt-')?'receipt':'content',()=>previous.call(this));};
 return ()=>{prototype.sync=previous;};
}
test('private receipt and content directory sync overlap but neither public authority nor close completes before both',{timeout:10000},async()=>{
 const f=await fixture(),directory=Promise.withResolvers<void>(),receipt=Promise.withResolvers<void>(),releaseDirectory=Promise.withResolvers<void>(),releaseReceipt=Promise.withResolvers<void>();let roots=0,notifications=0,settled=false,closed=false,syncs=0;
 const restore=await interceptSync(f,async(kind,original)=>{syncs++;if(kind==='directory'&&++roots===1){directory.resolve();await releaseDirectory.promise;}if(kind==='receipt'){receipt.resolve();await releaseReceipt.promise;}await original();});
 let publication:ReturnType<typeof f.publish>|undefined,closing:Promise<void>|undefined;
 try{
  f.store.observeChanges(()=>notifications++);publication=f.publish();void publication.then(()=>{settled=true;},()=>{settled=true;});await Promise.all([directory.promise,receipt.promise]);assert(!(await readdir(f.root)).includes('job.json'));assert((await readdir(f.root)).some(name=>name.startsWith('.receipt-')));assert.equal(notifications,0);assert(f.store.status.reservedBytes>0);await assert.rejects(f.publish('overflow'),/limit/);
  closing=f.store.close().then(()=>{closed=true;});releaseReceipt.resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);assert.equal(closed,false);assert(!(await readdir(f.root)).includes('job.json'));releaseDirectory.resolve();const record=await publication;await closing;assert.equal(syncs,5);assert.equal(roots,2);assert.equal(notifications,1);assert.equal(f.store.status.reservedBytes,0);
  restore();const next=await PublishedPrintFiles.open(f.root);try{assert.deepEqual(await next.inspect('job'),record);assert.deepEqual((await next.readBytes('job',signal())).bytes,Buffer.from('G1 X1\n'));assert.deepEqual((await next.readPreview('job',signal()))?.bytes,png);}finally{await next.close();}
 }finally{releaseDirectory.resolve();releaseReceipt.resolve();await publication?.catch(()=>{});await closing;restore();await f.close();}
});
for(const failed of ['directory','receipt'])test(failed+' failure drains the other private authority barrier before cleanup or close',{timeout:10000},async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),faulted=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let roots=0,settled=false,closed=false,notifications=0;const fault=new Error(failed+' authority fault');
 const restore=await interceptSync(f,async(kind,original)=>{if(kind==='directory'&&++roots>1)return original();if(kind===failed){faulted.resolve();throw fault;}if(kind==='directory'||kind==='receipt'){entered.resolve();await release.promise;}await original();});let rejected:Promise<void>|undefined,closing:Promise<void>|undefined;
 try{
  f.store.observeChanges(()=>notifications++);rejected=assert.rejects(f.publish(),error=>error===fault).then(()=>{settled=true;});await Promise.all([entered.promise,faulted.promise]);closing=f.store.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);assert.equal(closed,false);assert(f.store.status.reservedBytes>0);assert(!(await readdir(f.root)).includes('job.json'));release.resolve();await rejected;await closing;assert.equal(notifications,0);assert.equal(f.store.status.reservedBytes,0);assert.equal(f.store.status.writeFault,undefined);
  restore();const next=await PublishedPrintFiles.open(f.root);try{assert.deepEqual(await readdir(f.root),[]);assert.equal(next.status.storedBytes,0);await next.publish('retry','retry.gcode',f.model,signal(),undefined,f.preview);}finally{await next.close();}
 }finally{release.resolve();await rejected?.catch(()=>{});await closing;restore();await f.close();}
});
for(const held of ['directory','receipt'])test('cancellation drains held '+held+' authority preparation without linking or announcing a receipt',{timeout:10000},async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),otherDone=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),controller=new AbortController();let roots=0,settled=false,closed=false,notifications=0;
 const restore=await interceptSync(f,async(kind,original)=>{if(kind==='directory'&&++roots>1)return original();if(kind===held){entered.resolve();await release.promise;}await original();if((kind==='directory'||kind==='receipt')&&kind!==held)otherDone.resolve();});let rejected:Promise<void>|undefined,closing:Promise<void>|undefined;
 try{
  f.store.observeChanges(()=>notifications++);rejected=assert.rejects(f.publish('job',controller.signal),error=>error===controller.signal.reason).then(()=>{settled=true;});await Promise.all([entered.promise,otherDone.promise]);controller.abort(new Error('authority cancelled'));closing=f.store.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);assert.equal(closed,false);assert(!(await readdir(f.root)).includes('job.json'));release.resolve();await rejected;await closing;assert.equal(notifications,0);assert.equal(f.store.status.reservedBytes,0);
  restore();const next=await PublishedPrintFiles.open(f.root);try{assert.deepEqual(await readdir(f.root),[]);assert.equal(next.status.storedBytes,0);}finally{await next.close();}
 }finally{release.resolve();await rejected?.catch(()=>{});await closing;restore();await f.close();}
});
for(const same of [false,true])test('authority preparation retains '+(same?'one shared failure identity':'both distinct failures in barrier order'),{timeout:10000},async()=>{
 const f=await fixture(),directory=Promise.withResolvers<void>(),receipt=Promise.withResolvers<void>(),directoryFault=new Error('directory authority fault'),receiptFault=same?directoryFault:new Error('receipt authority fault');let roots=0;
 const restore=await interceptSync(f,async(kind,original)=>{if(kind==='directory'&&++roots===1){directory.resolve();await receipt.promise;throw directoryFault;}if(kind==='receipt'){receipt.resolve();await directory.promise;throw receiptFault;}await original();});
 try{await assert.rejects(f.publish(),error=>{if(same)assert.strictEqual(error,directoryFault);else{assert(error instanceof AggregateError);assert.deepEqual(error.errors,[directoryFault,receiptFault]);}return true;});assert.equal(f.store.status.reservedBytes,0);assert(!(await readdir(f.root)).includes('job.json'));assert(!(await readdir(f.root)).some(name=>name.startsWith('.')));}
 finally{directory.resolve();receipt.resolve();restore();await f.close();}
});
test('SIGKILL with durable private receipt and pending content directory barrier preserves old authority and recovers orphans',{timeout:15000},async()=>{
 const f=await fixture();let child:ReturnType<typeof spawn>|undefined,exited:Promise<unknown>|undefined;
 try{
  const previous=await f.publish('previous');await f.store.close();await writeFile(f.modelPath,'G1 X2\n');
  const script=`import {open,readlink} from 'node:fs/promises';import {PublishedPrintFiles} from ${JSON.stringify(moduleUrl)};process.on('message',()=>{});const model=await open(process.argv[2],'r'),preview=await open(process.argv[3],'r'),proto=Object.getPrototypeOf(model),sync=proto.sync;let roots=0;proto.sync=async function(){const path=await readlink('/proc/self/fd/'+this.fd);if(path===process.argv[1]&&++roots===1)await new Promise(()=>{});await sync.call(this);if(path.includes('/.receipt-'))process.send('private-receipt-durable');};const store=await PublishedPrintFiles.open(process.argv[1]);await store.publish('interrupted','file',model,new AbortController().signal,undefined,preview);throw Error('must not acknowledge');`;
  child=spawn(process.execPath,['--input-type=module','-e',script,f.root,f.modelPath,f.previewPath],{stdio:['ignore','ignore','pipe','ipc']});let stderr='';child.stderr!.on('data',chunk=>stderr+=chunk);exited=once(child,'exit');await Promise.race([once(child,'message',{signal:AbortSignal.timeout(10000)}).then(([message])=>assert.equal(message,'private-receipt-durable')),exited.then(()=>{throw new Error('early child exit: '+stderr);})]);assert(!(await readdir(f.root)).includes('interrupted.json'));assert((await readdir(f.root)).some(name=>name.startsWith('.receipt-')));assert(child.kill('SIGKILL'));await exited;assert.equal(child.signalCode,'SIGKILL');
  for(let i=0;i<2;i++){const next=await PublishedPrintFiles.open(f.root);try{assert.deepEqual(await next.inspect('previous'),previous);await assert.rejects(next.inspect('interrupted'),{code:'ENOENT'});assert.deepEqual((await next.readBytes('previous',signal())).bytes,Buffer.from('G1 X1\n'));assert.deepEqual((await next.readPreview('previous',signal()))?.bytes,png);assert.deepEqual((await readdir(f.root)).sort(),[previous.sha256+'.gcode',previous.preview!.sha256+'.png','previous.json'].sort());assert.equal(next.status.reservedBytes,0);}finally{await next.close();}}
 }finally{if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;await f.close();}
});
