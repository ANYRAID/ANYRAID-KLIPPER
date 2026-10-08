import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {sealedBuffer} from '../src/storage/sealed-buffer.ts';
import {PrintSnapshotBudget} from '../src/gcode/snapshot-budget.ts';
import {MetadataSnapshots} from '../src/moonraker/metadata-snapshots.ts';
import {ThumbnailStorage} from '../src/moonraker/thumbnail-storage.ts';
import {FileMetadataStore} from '../src/moonraker/file-metadata.ts';
import {restoreCurrentMetadata} from '../src/moonraker/metadata-version-recovery.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MetadataScanIntents} from '../src/moonraker/metadata-intents.ts';
import {MetadataVersions,MetadataVersionWriteError} from '../src/moonraker/metadata-versions.ts';
const signal=new AbortController().signal;
async function fixture(options:{maxFiles?:number;maxPending?:number}={}){const dir=await mkdtemp(join(tmpdir(),'metadata-versions-')),intents=await MetadataScanIntents.open(join(dir,'intents')),versions=await MetadataVersions.open(join(dir,'versions'),options);return {dir,intents,versions,close:async()=>{await versions.close();await intents.close();await rm(dir,{recursive:true,force:true});}};}
test('durable pending generations reject late selection and selected heads survive reopen',async()=>{
 const f=await fixture();try{
  const a=await f.intents.begin('part.gcode',signal),b=await f.intents.begin('part.gcode',signal),first=await f.versions.begin(a,signal),second=await f.versions.begin(b,signal);assert.equal(await f.versions.select(first,signal),null);assert.equal(await f.versions.select({...second},signal),null);
  const selected=await f.versions.select(second,signal);assert.ok(selected);assert.equal(selected.state,'selected');assert.equal(f.versions.canRetire(a),true);assert.equal(f.versions.canRetire(b),false);assert.equal(f.versions.isCurrent(second),false);assert.equal(await f.versions.select(selected,signal),null);await f.versions.close();const recovered=await MetadataVersions.open(join(f.dir,'versions'));
  try{assert.deepEqual(recovered.current('part.gcode'),selected);assert.equal(await recovered.select(second,signal),null);assert.equal((await readdir(join(f.dir,'versions'))).filter(name=>name.endsWith('.json')).length,1);}finally{await recovered.close();}
 }finally{await f.close();}
});
test('invalidation persists and prevents recovery falling back to the old selected snapshot',async()=>{
 const f=await fixture();try{const intent=await f.intents.begin('part.gcode',signal),pending=await f.versions.begin(intent,signal);await f.versions.select(pending,signal);const invalidated=await f.versions.invalidate('part.gcode',signal);assert.equal(invalidated.state,'invalidated');assert.equal(invalidated.scanId,null);assert.equal(f.versions.canRetire(intent),true);await f.versions.close();const recovered=await MetadataVersions.open(join(f.dir,'versions'));try{assert.deepEqual(recovered.current('part.gcode'),invalidated);const next=await recovered.begin(await f.intents.begin('next.gcode',signal),signal);assert.ok(BigInt(next.sequence)>BigInt(invalidated.sequence));}finally{await recovered.close();}}finally{await f.close();}
});
test('file and queue bounds plus preabort do not destroy valid version state',async()=>{
 const f=await fixture({maxFiles:1,maxPending:1});try{const intent=await f.intents.begin('part.gcode',signal),pending=f.versions.begin(intent,signal);await assert.rejects(f.versions.invalidate('other.gcode',signal),/queue/);const current=await pending;await assert.rejects(f.versions.invalidate('other.gcode',signal),/capacity/);await assert.rejects(f.versions.invalidate('part.gcode',AbortSignal.abort(new Error('cancel'))),/cancel/);assert.equal(f.versions.current('part.gcode'),current);assert.equal(f.versions.status.faulted,false);assert.ok(await f.versions.select(current,signal));}finally{await f.close();}
});
test('failed compaction retains the new durable head and recovery cleans obsolete events',async()=>{
 const f=await fixture(),probe=await open('/dev/null','r'),prototype=Object.getPrototypeOf(probe),original=prototype.sync;await probe.close();let calls=0;try{
  await f.versions.invalidate('part.gcode',signal);const a=await f.intents.begin('part.gcode',signal),first=await f.versions.begin(a,signal),b=await f.intents.begin('part.gcode',signal);let candidate:import('../src/moonraker/metadata-versions.ts').MetadataVersion|undefined;
  // New event publication uses four sync calls; fifth sync follows removal of
  // the two obsolete receipts. No destructive rollback of the new head is permitted.
  prototype.sync=function(...args:unknown[]){if(++calls===5)return Promise.reject(new Error('injected compaction sync failure'));return Reflect.apply(original,this,args);};
  try{await assert.rejects(f.versions.begin(b,signal),(error:any)=>{assert.ok(error instanceof MetadataVersionWriteError);candidate=error.candidate;return true;});}finally{prototype.sync=original;}
  assert.equal(f.versions.status.faulted,true);assert.throws(()=>f.versions.current('part.gcode'),/recovered/);await f.versions.close();const recovered=await MetadataVersions.open(join(f.dir,'versions'));try{assert.deepEqual(recovered.current('part.gcode'),candidate);assert.notEqual(recovered.current('part.gcode')?.id,first.id);assert.equal((await readdir(join(f.dir,'versions'))).filter(name=>name.endsWith('.json')).length,1);}finally{await recovered.close();}
 }finally{prototype.sync=original;await f.close();}
});
test('same-filename generations compact without losing the global high-water sequence',async()=>{
 const f=await fixture();try{let previous=0n;for(let i=0;i<12;i++){const pending=await f.versions.begin(await f.intents.begin(i%2?'a.gcode':'b.gcode',signal),signal);assert.ok(BigInt(pending.sequence)>previous);previous=BigInt(pending.sequence);await f.versions.select(pending,signal);}assert.equal(f.versions.entries().length,2);assert.equal((await readdir(join(f.dir,'versions'))).filter(name=>name.endsWith('.json')).length,2);await f.versions.close();const recovered=await MetadataVersions.open(join(f.dir,'versions'));try{assert.equal(recovered.status.sequence,'24');assert.equal((await recovered.invalidate('a.gcode',signal)).sequence,'25');}finally{await recovered.close();}}finally{await f.close();}
});

test('current-version recovery restores selected fields but never pending or invalidated predecessors',async()=>{
 const f=await fixture(),snapshots=await MetadataSnapshots.open(join(f.dir,'snapshots')),images=await ThumbnailStorage.open(join(f.dir,'images')),cache=new FileMetadataStore();try{
  const intent=await f.intents.begin('part.gcode',signal),pending=await f.versions.begin(intent,signal);await snapshots.put(intent,{dev:1n,ino:2n,mtimeNs:3n,ctimeNs:4n},{size:77,modified:1,thumbnails:[]},signal);
  const restore=()=>restoreCurrentMetadata({versions:f.versions,snapshots,images,cache,ticket:cache.begin('part.gcode'),signal,validateSource:async()=>true});
  assert.equal(await restore(),false);assert.equal(cache.peek('part.gcode'),undefined);await f.versions.select(pending,signal);assert.equal(await restore(),true);assert.equal(cache.metadata('part.gcode').size,77);
  await f.versions.begin(await f.intents.begin('part.gcode',signal),signal);assert.equal(await restore(),false);assert.equal(cache.peek('part.gcode'),undefined);await f.versions.invalidate('part.gcode',signal);assert.equal(await restore(),false);
 }finally{await snapshots.close();await images.close();await f.close();}
});
test('version changes during snapshot verification prevent stale recovery cache publication',async()=>{
 const f=await fixture(),snapshots=await MetadataSnapshots.open(join(f.dir,'snapshots')),images=await ThumbnailStorage.open(join(f.dir,'images')),cache=new FileMetadataStore();try{
  const intent=await f.intents.begin('part.gcode',signal),pending=await f.versions.begin(intent,signal);await snapshots.put(intent,{dev:1n,ino:2n,mtimeNs:3n,ctimeNs:4n},{size:77,modified:1,thumbnails:[]},signal);await f.versions.select(pending,signal);let checks=0;
  assert.equal(await restoreCurrentMetadata({versions:f.versions,snapshots,images,cache,ticket:cache.begin('part.gcode'),signal,validateSource:async()=>{if(++checks===1)await f.versions.invalidate('part.gcode',signal);return true;}}),false);assert.equal(cache.peek('part.gcode'),undefined);assert.equal(cache.status.entries,0);
 }finally{await snapshots.close();await images.close();await f.close();}
});

test('recovery and advancement preserve sequence values beyond safe Number precision',async()=>{
 const f=await fixture();try{await f.versions.close();const store=await PublishedPrintFiles.open(join(f.dir,'versions')),sequence='9007199254740993',value={version:1,id:'mv-'+sequence,sequence,filename:'part.gcode',state:'invalidated',scanId:null},stage=await sealedBuffer(Buffer.from(JSON.stringify(value)),signal,new PrintSnapshotBudget({maxBytes:65536,maxSnapshots:1}));try{await store.publish(value.id,'metadata-version',stage.file,signal);}finally{await stage.close();await store.close();}
  const recovered=await MetadataVersions.open(join(f.dir,'versions'));try{assert.equal(recovered.status.sequence,sequence);assert.equal((await recovered.invalidate('part.gcode',signal)).sequence,'9007199254740994');}finally{await recovered.close();}
 }finally{await f.close();}
});
