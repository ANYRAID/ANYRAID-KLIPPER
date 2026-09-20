import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
const signal=()=>new AbortController().signal;
async function fixture(options:Parameters<typeof PublishedPrintFiles.open>[1]={}){const directory=await mkdtemp(join(tmpdir(),'published-recovery-')),root=join(directory,'store'),sourcePath=join(directory,'source');await writeFile(sourcePath,'G1 X1\n');const source=await open(sourcePath,'r'),store=await PublishedPrintFiles.open(root,options);return {directory,root,source,store,async close(){await store.close();await source.close();await rm(directory,{recursive:true,force:true});}};}
test('directory ownership lock excludes second instance and separate process until close',async()=>{
 const f=await fixture();const script=`import {PublishedPrintFiles} from ${JSON.stringify(new URL('../src/storage/published-files.ts',import.meta.url).href)};try{const s=await PublishedPrintFiles.open(process.argv[1]);await s.close();process.stdout.write('opened');}catch(e){if(!String(e).includes('Lock published file directory'))throw e;process.stdout.write('locked');}`;
 try{await assert.rejects(PublishedPrintFiles.open(f.root),/Lock published file directory/);const locked=spawnSync(process.execPath,['--input-type=module','-e',script,f.root],{encoding:'utf8',timeout:10000});assert.equal(locked.status,0,locked.stderr);assert.equal(locked.stdout,'locked');await f.store.close();const free=spawnSync(process.execPath,['--input-type=module','-e',script,f.root],{encoding:'utf8',timeout:10000});assert.equal(free.status,0,free.stderr);assert.equal(free.stdout,'opened');}finally{await f.close();}
});
test('startup validates references then removes only known temporary and orphan content',async()=>{
 const f=await fixture();try{const record=await f.store.publish('job','file',f.source,signal());await f.store.close();const names=['.upload-'+randomUUID(),'.receipt-'+randomUUID(),'0'.repeat(64)+'.gcode'];for(const name of names)await writeFile(join(f.root,name),'orphan');const recovered=await PublishedPrintFiles.open(f.root);try{assert.deepEqual((await readdir(f.root)).sort(),['job.json',record.sha256+'.gcode'].sort());assert.deepEqual(await recovered.inspect('job'),record);assert.equal(recovered.status.publishedFiles,1);assert.equal(recovered.status.storedBytes,record.size+Buffer.byteLength(JSON.stringify(record)));}finally{await recovered.close();}}finally{await f.close();}
});
test('corrupt receipt or unknown entry prevents any recovery deletion',async()=>{
 const f=await fixture();try{await f.store.close();const temp='.upload-'+randomUUID();await writeFile(join(f.root,temp),'keep');await writeFile(join(f.root,'bad.json'),'{}');await assert.rejects(PublishedPrintFiles.open(f.root),/receipt/);assert.ok((await readdir(f.root)).includes(temp));await rm(join(f.root,'bad.json'));await writeFile(join(f.root,'unrecognized'),'keep');await assert.rejects(PublishedPrintFiles.open(f.root),/Unknown/);assert.ok((await readdir(f.root)).includes(temp));}finally{await f.close();}
});
test('publication file quota survives reopening while snapshot reads remain usable',async()=>{
 const f=await fixture({maxPublishedFiles:1});try{await f.store.publish('one','file',f.source,signal());await assert.rejects(f.store.publish('two','file',f.source,signal()),/quota/);assert.equal(f.store.status.reservedBytes,0);await f.store.close();const recovered=await PublishedPrintFiles.open(f.root,{maxPublishedFiles:1});try{assert.equal(recovered.status.publishedFiles,1);await assert.rejects(recovered.publish('two','file',f.source,signal()),/quota/);const reader=await recovered.acquire('one',signal());await reader.close();}finally{await recovered.close();}}finally{await f.close();}
});
test('disk reservation rejects concurrent copy without creating another temporary file',async()=>{
 const f=await fixture({maxStorageBytes:3000}),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),controller=new AbortController();
 const source={stat:()=>f.source.stat({bigint:true}),read:async(buffer:Buffer,offset:number,length:number,position:number)=>{entered.resolve();await release.promise;return f.source.read(buffer,offset,length,position);}} as unknown as import('node:fs/promises').FileHandle;
 try{const first=f.store.publish('first','file',source,controller.signal),rejected=assert.rejects(first);await entered.promise;assert.equal(f.store.status.reservedBytes,2054);await assert.rejects(f.store.publish('second','file',f.source,signal()),/quota/);assert.equal((await readdir(f.root)).length,1);controller.abort();release.resolve();await rejected;assert.equal(f.store.status.reservedBytes,0);assert.deepEqual(await readdir(f.root),[]);}finally{release.resolve();await f.close();}
});
test('a lower byte quota after reopening permits reads but refuses new publication',async()=>{
 const f=await fixture();try{await f.store.publish('one','file',f.source,signal());await f.store.close();const recovered=await PublishedPrintFiles.open(f.root,{maxStorageBytes:1});try{assert.ok(recovered.status.storedBytes>1);const reader=await recovered.acquire('one',signal());await reader.close();await assert.rejects(recovered.publish('two','file',f.source,signal()),/quota/);}finally{await recovered.close();}}finally{await f.close();}
});
test('killed uploader releases directory lock and recovery preserves committed files', {timeout:15000}, async()=>{
 const f=await fixture();
 let child:ReturnType<typeof spawn>|undefined;
 let exited:Promise<unknown>|undefined;
 try{
  const record=await f.store.publish('committed','file',f.source,signal());
  await f.store.close();
  const path=join(f.directory,'large');await writeFile(path,'G1 X1\n'.repeat(20000));
  const script=`
   import {open} from 'node:fs/promises';
   import {PublishedPrintFiles} from ${JSON.stringify(new URL('../src/storage/published-files.ts',import.meta.url).href)};
   process.on('message',()=>{});
   const store=await PublishedPrintFiles.open(process.argv[1]);
   const file=await open(process.argv[2],'r');
   const source={stat:()=>file.stat({bigint:true}),read:async(...args)=>{
    if(args[3]>0){process.send('copy-paused');await new Promise(()=>{});}
    return file.read(...args);
   }};
   await store.publish('interrupted','file',source,new AbortController().signal);
   throw new Error('Copy must remain paused');`;
  child=spawn(process.execPath,['--input-type=module','-e',script,f.root,path],{stdio:['ignore','ignore','pipe','ipc']});
  const processHandle=child;
  let stderr='';child.stderr!.on('data',data=>{stderr+=data;});
  exited=once(child,'exit');
  await Promise.race([
   once(child,'message',{signal:AbortSignal.timeout(10000)}).then(([message])=>assert.equal(message,'copy-paused')),
   exited.then(()=>{throw new Error(`Uploader exited before pause: ${stderr}`);}),
  ]);
  await assert.rejects(PublishedPrintFiles.open(f.root),/Lock published file directory/);
  assert.ok((await readdir(f.root)).some(name=>name.startsWith('.upload-')));
  assert.equal(processHandle.kill('SIGKILL'),true);await exited;
  assert.equal(processHandle.signalCode,'SIGKILL');
  const recovered=await PublishedPrintFiles.open(f.root);
  try{
   assert.deepEqual((await readdir(f.root)).sort(),['committed.json',record.sha256+'.gcode'].sort());
   assert.deepEqual(await recovered.inspect('committed'),record);
   assert.equal(recovered.status.reservedBytes,0);
   await assert.rejects(recovered.inspect('interrupted'),{code:'ENOENT'});
   const reader=await recovered.acquire('committed',signal());await reader.close();
   await recovered.publish('retry','file',f.source,signal());
  }finally{await recovered.close();}
 }finally{if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;await f.close();}
});
