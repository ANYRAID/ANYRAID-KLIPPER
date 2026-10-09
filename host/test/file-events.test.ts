import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,open,writeFile,rename,rm,mkdir,readdir,readlink} from 'node:fs/promises';
import {AsyncLocalStorage} from 'node:async_hooks';
import {join} from 'node:path';
import {tmpdir,endianness} from 'node:os';
import {createRequire} from 'node:module';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {FileEvents,fileEventMask as mask,parseFileEvents,type FileEvent} from '../src/moonraker/file-events.ts';
const native=createRequire(import.meta.url)(process.env.ANYRAID_FILE_EVENTS_ADDON??'../build/file-events.node') as {create(callback:(bytes:Buffer|null,error:string|null)=>void):object;add(owner:unknown,fd:unknown):number;close(owner:unknown):void;};
const until=async(check:()=>boolean)=>{const end=Date.now()+4000;while(!check()){assert(Date.now()<end,'Directory event deadline exceeded');await new Promise<void>(r=>setTimeout(r,5));}};
const chunk=(watch:number,event:number,name='')=>{const bytes=Buffer.from(name+'\0'),length=name?Math.ceil(bytes.length/16)*16:0,b=Buffer.alloc(16+length),view=new DataView(b.buffer,b.byteOffset,b.byteLength),little=endianness()==='LE';view.setInt32(0,watch,little);view.setUint32(4,event,little);view.setUint32(8,17,little);view.setUint32(12,length,little);if(length)bytes.copy(b,16);return b;};
test('event decoder preserves kernel identity and Unicode, rejects corruption and fails explicitly on lost events',()=>{
 const bytes=Buffer.concat([chunk(7,mask.create,'部件.ufp'),chunk(7,mask.closeWrite,'部件.ufp')]),events=parseFileEvents(bytes);assert.deepEqual(events.map(e=>[e.watch,e.mask,e.cookie,e.name]),[[7,mask.create,17,'部件.ufp'],[7,mask.closeWrite,17,'部件.ufp']]);assert(Object.isFrozen(events));assert(Object.isFrozen(events[0]));
 assert.throws(()=>parseFileEvents(chunk(-1,mask.overflow)),/queue overflow/);assert.throws(()=>parseFileEvents(chunk(-2,mask.open)),/watch/);assert.throws(()=>parseFileEvents(bytes.subarray(0,15)),/header/);assert.throws(()=>parseFileEvents(bytes.subarray(0,17)),/length/);assert.throws(()=>parseFileEvents(chunk(1,mask.open,'a/b')),/name/);const invalid=chunk(1,mask.create,'a');invalid[16]=255;assert.throws(()=>parseFileEvents(invalid));const padding=chunk(1,mask.create,'a');padding[31]=1;assert.throws(()=>parseFileEvents(padding),/terminator/);
 assert.equal(parseFileEvents(chunk(1,mask.closeWrite,'\uFEFFpart.ufp'))[0].name,'\uFEFFpart.ufp');
});
test('complete archive bytes remain unready until the real writable descriptor closes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'file-events-')),root=await open(dir,'r'),events:FileEvent[]=[],faults:unknown[]=[],watcher=new FileEvents(batch=>events.push(...batch),cause=>faults.push(cause));let writer:Awaited<ReturnType<typeof open>>|undefined;
 try{
  const wd=watcher.add(root);writer=await open(join(dir,'模型.ufp'),'wx');await writer.writeFile(Buffer.from('a complete archive may still be open'));await until(()=>events.some(e=>e.mask&mask.modify));await new Promise<void>(r=>setTimeout(r,40));assert(!events.some(e=>e.mask&mask.closeWrite));
  await writer.close();writer=undefined;await until(()=>events.some(e=>e.mask&mask.closeWrite));assert(events.filter(e=>e.name==='模型.ufp').every(e=>e.watch===wd));assert.equal(faults.length,0);assert.equal((await root.stat()).isDirectory(),true);
  await watcher.close();assert.equal(watcher.status.closed,true);assert.equal(watcher.status.watches,0);const count=events.length;await writeFile(join(dir,'later.ufp'),'later');await new Promise<void>(r=>setTimeout(r,20));assert.equal(events.length,count);await watcher.close();
 }finally{await writer?.close();await watcher.close();await root.close();await rm(dir,{recursive:true,force:true});}
});
test('moved-in files and watched-directory movement retain their kernel watch identity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'file-events-move-')),inbox=join(dir,'inbox'),moved=join(dir,'moved');await mkdir(inbox);const root=await open(inbox,'r'),events:FileEvent[]=[],watcher=new FileEvents(batch=>events.push(...batch),cause=>assert.fail(String(cause)));
 try{const wd=watcher.add(root);await writeFile(join(dir,'staged'),'archive');await rename(join(dir,'staged'),join(inbox,'part.ufp'));await until(()=>events.some(e=>e.mask&mask.movedTo));assert(events.some(e=>e.watch===wd&&e.name==='part.ufp'&&e.mask&mask.movedTo));await rename(inbox,moved);await until(()=>events.some(e=>e.mask&mask.moveSelf));await writeFile(join(moved,'second.ufp'),'second');await until(()=>events.some(e=>e.name==='second.ufp'&&e.mask&mask.closeWrite));assert.equal((await root.stat()).isDirectory(),true);}finally{await watcher.close();await root.close();await rm(dir,{recursive:true,force:true});}
});
test('native watch validates descriptors and owner tags, borrows the directory and closes idempotently',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'file-events-native-')),root=await open(dir,'r'),file=await open(join(dir,'ordinary'),'w'),closed=Promise.withResolvers<void>();const owner=native.create((bytes,error)=>{assert.equal(error,null);if(bytes===null)closed.resolve();});
 try{for(const fd of [-1,1.5,NaN,Infinity,2147483648,'3',null])assert.throws(()=>native.add(owner,fd));assert.throws(()=>native.add({},root.fd),/owner/);assert.throws(()=>native.close({}),/owner/);assert.throws(()=>native.add(owner,file.fd),/directory/);assert(Number.isSafeInteger(native.add(owner,root.fd)));native.close(owner);native.close(owner);await closed.promise;assert.throws(()=>native.add(owner,root.fd),/closed/);assert.equal((await root.stat()).isDirectory(),true);}finally{native.close(owner);await closed.promise;await file.close();await root.close();await rm(dir,{recursive:true,force:true});}
});
test('observer failure preserves its cause and joins retirement before accepting further work',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'file-events-fault-')),root=await open(dir,'r'),cause=new Error('Controlled directory consumer fault'),observed:unknown[]=[],watcher=new FileEvents(()=>{throw cause;},fault=>observed.push(fault));
 try{watcher.add(root);await writeFile(join(dir,'fault.ufp'),'archive');await until(()=>observed.length>0);await watcher.close();assert.deepEqual(observed,[cause]);assert.equal(watcher.status.fault,cause);assert(watcher.status.closed);assert.throws(()=>watcher.add(root),/closed/);}finally{await watcher.close();await root.close();await rm(dir,{recursive:true,force:true});}
});
test('event owner enforces its directory capacity and releases all kernel watch descriptors',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'file-events-capacity-')),handles:Awaited<ReturnType<typeof open>>[]=[],watcher=new FileEvents(()=>{},()=>{});
 try{for(let i=0;i<1025;i++){const path=join(dir,String(i));await mkdir(path);const handle=await open(path,'r');handles.push(handle);if(i<1024)watcher.add(handle);else assert.throws(()=>watcher.add(handle),/capacity/);}assert.equal(watcher.status.watches,1024);await watcher.close();assert.equal(watcher.status.watches,0);}finally{await watcher.close();await Promise.all(handles.map(handle=>handle.close()));await rm(dir,{recursive:true,force:true});}
});
test('worker termination retires the active native event owner without an explicit close',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'file-events-worker-')),module=new URL('../src/moonraker/file-events.'+(import.meta.url.endsWith('.ts')?'ts':'js'),import.meta.url).href;
 const descriptors=async()=>{const names=await readdir('/proc/self/fd'),links=await Promise.all(names.map(name=>readlink('/proc/self/fd/'+name).catch(()=>'')));return links.filter(link=>link==='anon_inode:inotify').length;},initial=await descriptors();
 // The watch borrows the descriptor only during add. Retire the unrelated
 // FileHandle explicitly while keeping the native event owner active.
 const worker=new Worker(`const {parentPort}=require('node:worker_threads');(async()=>{const {open}=await import('node:fs/promises'),{FileEvents}=await import(${JSON.stringify(module)});const directory=await open(${JSON.stringify(dir)},'r'),watcher=new FileEvents(events=>{if(events.some(event=>event.name==='active'))parentPort.postMessage('event');},error=>{throw error;});try{watcher.add(directory);}finally{await directory.close();}parentPort.postMessage('ready');setInterval(()=>{},1000);})();`,{eval:true});
 try{const [message]=await once(worker,'message');assert.equal(message,'ready');assert.equal(await descriptors(),initial+1);const event=once(worker,'message');await writeFile(join(dir,'active'),'active owner');assert.equal((await event)[0],'event');assert.equal(await worker.terminate(),1);assert.equal(await descriptors(),initial);}finally{await worker.terminate();await rm(dir,{recursive:true,force:true});}
});
test('directory callbacks retain their owner async context and repeated closes release native descriptors',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'file-events-context-')),root=await open(dir,'r'),storage=new AsyncLocalStorage<string>();
 const descriptors=async()=>{const names=await readdir('/proc/self/fd');const links=await Promise.all(names.map(name=>readlink('/proc/self/fd/'+name).catch(()=>'')));return links.filter(link=>link==='anon_inode:inotify').length;};
 try{const initial=await descriptors();for(let index=0;index<32;index++){
  const observed:string[]=[],watcher=storage.run('directory-owner',()=>new FileEvents(()=>observed.push(storage.getStore()??'lost'),cause=>assert.fail(String(cause))));
  watcher.add(root);await writeFile(join(dir,String(index)),'event');await until(()=>observed.length>0);assert(observed.every(value=>value==='directory-owner'));await watcher.close();
 }assert.equal(await descriptors(),initial);}finally{await root.close();await rm(dir,{recursive:true,force:true});}
});
