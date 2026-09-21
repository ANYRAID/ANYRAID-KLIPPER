import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,open,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import sharp from 'sharp';
import {MetadataLifecycle} from '../src/moonraker/metadata-lifecycle.ts';
import {MetadataScanIntents} from '../src/moonraker/metadata-intents.ts';
import {MetadataSnapshots} from '../src/moonraker/metadata-snapshots.ts';
import {MetadataVersions} from '../src/moonraker/metadata-versions.ts';
import {ThumbnailStorage} from '../src/moonraker/thumbnail-storage.ts';
import {MetadataExtractor} from '../src/moonraker/metadata-extractor.ts';
import {ThumbnailProcessor} from '../src/moonraker/thumbnail-process.ts';
import {FileMetadataStore} from '../src/moonraker/file-metadata.ts';
const signal=new AbortController().signal;
async function fixture(maxPending=4){
 const dir=await mkdtemp(join(tmpdir(),'metadata-owner-')),path=join(dir,'part.gcode'),png=await sharp({create:{width:32,height:32,channels:3,background:'blue'}}).png().toBuffer(),b64=png.toString('base64');await writeFile(path,`; thumbnail begin 32 32 ${b64.length}\n; ${b64}\n; thumbnail end\nG1 X1 F600\n`);
 const extractor=await MetadataExtractor.open(),processor=await ThumbnailProcessor.open(),images=await ThumbnailStorage.open(join(dir,'images')),intents=await MetadataScanIntents.open(join(dir,'intents')),snapshots=await MetadataSnapshots.open(join(dir,'snapshots')),versions=await MetadataVersions.open(join(dir,'versions')),cache=new FileMetadataStore(),components={extractor,processor,images,intents,snapshots,versions,cache,maxPending},owner=new MetadataLifecycle(components);
 const validate=async(source:{dev:bigint;ino:bigint;mtimeNs:bigint;ctimeNs:bigint})=>{const current=await stat(path,{bigint:true});return current.dev===source.dev&&current.ino===source.ino&&current.mtimeNs===source.mtimeNs&&current.ctimeNs===source.ctimeNs;};
 return {dir,path,owner,components,validate,scan:async()=>owner.scan('part.gcode',await open(path,'r'),signal,validate),close:async()=>{await owner.close();await extractor.close();await processor.close();await images.close();await intents.close();await snapshots.close();await versions.close();await rm(dir,{recursive:true,force:true});}};
}
async function until(check:()=>boolean){for(let i=0;i<2000&&!check();i++)await delay(1);assert.equal(check(),true);}
test('owner composes scan, durable selection, recovery, replacement and safe retirement',async()=>{
 const f=await fixture();try{const first=await f.scan();assert.equal(first.committed,true);assert.equal(f.components.versions.current('part.gcode')?.scanId,first.intent.id);assert.equal(f.components.cache.thumbnails('part.gcode').length,1);await assert.rejects(f.owner.retire(first.intent,signal),/not retired/);
  f.components.cache.clear();assert.equal(await f.owner.recover('part.gcode',signal,f.validate),true);const second=await f.scan();assert.equal(second.committed,true);assert.equal(await f.owner.retireSuperseded(signal),1);assert.deepEqual(await f.components.images.listIds(signal),[second.intent.bundleId]);assert.deepEqual(await f.components.snapshots.listIds(signal),[second.snapshotId]);assert.deepEqual(f.components.intents.unresolved(),[second.intent]);
  await f.owner.invalidate('part.gcode',signal);assert.equal(await f.owner.recover('part.gcode',signal,f.validate),false);assert.equal(await f.owner.retireSuperseded(signal),1);assert.deepEqual(await f.components.images.listIds(signal),[]);assert.equal(f.components.intents.unresolved().length,0);
 }finally{await f.close();}
});
test('accepted replacement revokes old cache ticket while image preparation is active',async()=>{
 const f=await fixture();try{const pid=f.components.processor.status.pid!;process.kill(pid,'SIGSTOP');const first=f.scan(),firstSettled=first.then(value=>({value}),error=>({error}));await until(()=>f.components.processor.status.active);const source=await open(f.path,'r'),second=f.owner.scan('part.gcode',source,signal,f.validate);process.kill(pid,'SIGCONT');await firstSettled;const latest=await second;assert.equal(latest.committed,true);assert.equal(f.components.versions.current('part.gcode')?.scanId,latest.intent.id);assert.equal(source.fd,-1);assert.equal(await f.owner.retireSuperseded(signal),1);assert.deepEqual(await f.components.images.listIds(signal),[latest.intent.bundleId]);}finally{await f.close();}
});
test('queue rejection closes source without revoking the active scan and close drains accepted work',async()=>{
 const f=await fixture(1);try{const pid=f.components.processor.status.pid!;process.kill(pid,'SIGSTOP');const first=f.scan();await until(()=>f.components.processor.status.active);const rejected=await open(f.path,'r');await assert.rejects(f.owner.scan('part.gcode',rejected,signal,f.validate),/queue is full/);assert.equal(rejected.fd,-1);const closing=f.owner.close();process.kill(pid,'SIGCONT');assert.equal((await first).committed,true);await closing;assert.equal(f.owner.status.pending,0);assert.equal(f.components.processor.status.closed,false);const after=await open(f.path,'r');await assert.rejects(f.owner.scan('part.gcode',after,signal,f.validate),/closed/);assert.equal(after.fd,-1);}finally{await f.close();}
});
test('source change during selected-version sync is durably invalidated before public visibility',async()=>{
 const f=await fixture();try{const original=f.components.versions.select.bind(f.components.versions);f.components.versions.select=async(...args)=>{const selected=await original(...args);await writeFile(f.path,'G1 X999\n');return selected;};await assert.rejects(f.scan(),(e:any)=>e.cause?.status===409);assert.equal(f.components.cache.peek('part.gcode'),undefined);assert.equal(f.components.versions.current('part.gcode')?.state,'invalidated');assert.equal(await f.owner.retireSuperseded(signal),1);}finally{await f.close();}
});
test('one lifecycle exclusively owns components until its accepted work has drained',async()=>{
 const f=await fixture();try{assert.throws(()=>new MetadataLifecycle(f.components),/already/);await f.owner.close();const replacement=new MetadataLifecycle(f.components);try{assert.equal(await replacement.recover('part.gcode',signal,f.validate),false);}finally{await replacement.close();}}finally{await f.close();}
});
test('queued cancellation closes its accepted source before lifecycle close resolves',async()=>{
 const f=await fixture();try{const pid=f.components.processor.status.pid!;process.kill(pid,'SIGSTOP');const first=f.scan();await until(()=>f.components.processor.status.active);const controller=new AbortController(),source=await open(f.path,'r');const queued=f.owner.scan('other.gcode',source,controller.signal,f.validate),rejected=assert.rejects(queued,/queued cancel/);controller.abort(new Error('queued cancel'));const closing=f.owner.close();process.kill(pid,'SIGCONT');await first;await rejected;await closing;assert.equal(source.fd,-1);assert.equal(f.components.cache.peek('other.gcode'),undefined);}finally{await f.close();}
});
test('a new owner restores the selected version after every component has been reopened',async()=>{
 const f=await fixture();try{
  const result=await f.scan();await f.owner.close();const old=f.components;await old.extractor.close();await old.processor.close();await old.images.close();await old.intents.close();await old.snapshots.close();await old.versions.close();
  const extractor=await MetadataExtractor.open(),processor=await ThumbnailProcessor.open(),images=await ThumbnailStorage.open(join(f.dir,'images')),intents=await MetadataScanIntents.open(join(f.dir,'intents')),snapshots=await MetadataSnapshots.open(join(f.dir,'snapshots')),versions=await MetadataVersions.open(join(f.dir,'versions')),cache=new FileMetadataStore(),owner=new MetadataLifecycle({extractor,processor,images,intents,snapshots,versions,cache});
  try{assert.equal(await owner.recover('part.gcode',signal,f.validate),true);assert.equal(versions.current('part.gcode')?.scanId,result.intent.id);assert.equal(cache.thumbnails('part.gcode').length,1);assert.equal(await owner.retireSuperseded(signal),0);await owner.invalidate('part.gcode',signal);assert.equal(await owner.retireSuperseded(signal),1);assert.deepEqual(await images.listIds(signal),[]);}finally{await owner.close();await extractor.close();await processor.close();await images.close();await intents.close();await snapshots.close();await versions.close();}
 }finally{await f.close();}
});
test('failed current preparation retains its pending intent until explicit invalidation',async()=>{
 const f=await fixture();try{await writeFile(f.path,'; thumbnail begin 32 32 8\n; AAAAAAAA\n; thumbnail end\n');await assert.rejects(f.scan());assert.equal(f.components.versions.current('part.gcode')?.state,'pending');assert.equal(f.components.cache.peek('part.gcode'),undefined);assert.equal(await f.owner.retireSuperseded(signal),0);assert.equal(f.components.intents.unresolved().length,1);await f.owner.invalidate('part.gcode',signal);assert.equal(await f.owner.retireSuperseded(signal),1);assert.equal(f.components.intents.unresolved().length,0);}finally{await f.close();}
});
test('queued recovery cannot revoke the ticket of a later admitted scan',async()=>{
 const f=await fixture();try{
  await f.scan();const entered=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>(),begin=f.components.intents.begin.bind(f.components.intents);
  f.components.intents.begin=async(...args)=>{if(args[0]==='other.gcode'){entered.resolve();await resume.promise;}return begin(...args);};
  const other=f.owner.scan('other.gcode',await open(f.path,'r'),signal,f.validate);await entered.promise;
  const recovering=f.owner.recover('part.gcode',signal,f.validate),latest=f.scan();
  // f.scan opens asynchronously; ensure its cache ticket is admitted first.
  await until(()=>f.owner.status.pending===3);resume.resolve();await other;assert.equal(await recovering,false);assert.equal((await latest).committed,true);
 }finally{await f.close();}
});
test('history metadata exposes only selected immutable snapshots with their durable generation',async()=>{
 const f=await fixture();try{
  assert.equal(f.owner.historyMetadata('part.gcode'),undefined);
  const first=await f.scan(),snapshot=f.owner.historyMetadata('part.gcode')!;assert.equal(snapshot.generation,first.version!.id);assert.equal(snapshot.fields,f.components.cache.peek('part.gcode'));assert.ok(Object.isFrozen(snapshot.fields));
  await f.owner.invalidate('part.gcode',signal);assert.equal(f.owner.historyMetadata('part.gcode'),undefined);
  const second=await f.scan();assert.notEqual(f.owner.historyMetadata('part.gcode')!.generation,snapshot.generation);assert.equal(f.owner.historyMetadata('part.gcode')!.generation,second.version!.id);
 }finally{await f.close();}assert.throws(()=>f.owner.historyMetadata('part.gcode'),/closed/);
});
