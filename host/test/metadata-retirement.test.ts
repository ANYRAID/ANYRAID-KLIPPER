import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {MetadataScanIntents} from '../src/moonraker/metadata-intents.ts';
import {MetadataSnapshots} from '../src/moonraker/metadata-snapshots.ts';
import {ThumbnailStorage} from '../src/moonraker/thumbnail-storage.ts';
import {FileMetadataStore} from '../src/moonraker/file-metadata.ts';
import {retireMetadataScan} from '../src/moonraker/metadata-retirement.ts';
const signal=new AbortController().signal;
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'metadata-retirement-')),intents=await MetadataScanIntents.open(join(dir,'intents')),snapshots=await MetadataSnapshots.open(join(dir,'snapshots')),images=await ThumbnailStorage.open(join(dir,'images')),cache=new FileMetadataStore(),intent=await intents.begin('part.gcode',signal),bytes=await sharp({create:{width:32,height:32,channels:3,background:'red'}}).png().toBuffer(),bundle=await images.publish(intent.bundleId,[{bytes,width:32,height:32,format:'png',miniature:true}],signal),fields={size:1,modified:1,thumbnails:bundle.thumbnails},snapshot=await snapshots.put(intent,{dev:1n,ino:2n,mtimeNs:3n,ctimeNs:4n},fields,signal);return {dir,fields,snapshot,options:{intent,intents,snapshots,images,cache,signal,authorizeRetirement:async()=>true},close:async()=>{await snapshots.close();await images.close();await intents.close();await rm(dir,{recursive:true,force:true});}};}
test('referenced, denied or foreign retirement requests preserve every durable artifact',async()=>{
 const f=await fixture();try{
  const {cache,intent}=f.options;cache.commit(cache.begin('other.gcode'),f.fields);await assert.rejects(retireMetadataScan(f.options),/still referenced/);cache.clear();await assert.rejects(retireMetadataScan({...f.options,authorizeRetirement:async()=>false}),/not retired/);await assert.rejects(retireMetadataScan({...f.options,intent:{...intent}}),/stale/);
  assert.deepEqual(await f.options.snapshots.listIds(signal),[f.snapshot.id]);assert.deepEqual(await f.options.images.listIds(signal),[intent.bundleId]);assert.equal(f.options.intents.unresolved().length,1);
 }finally{await f.close();}
});
test('retirement removes snapshot then images then intent and blocks interleaved references',async()=>{
 const f=await fixture();try{
  const order:string[]=[],{cache,snapshots,images,intents,intent}=f.options,removeSnapshot=snapshots.remove.bind(snapshots),removeImage=images.remove.bind(images),ack=intents.acknowledge.bind(intents);
  snapshots.remove=async(...args)=>{order.push('snapshot');const ticket=cache.begin('racing.gcode');assert.throws(()=>cache.commit(ticket,f.fields),(e:any)=>e.status===409);cache.fail(ticket);cache.clear();assert.throws(()=>cache.guardThumbnailRetirement(intent.bundleId),/already/);await removeSnapshot(...args);};
  images.remove=async(...args)=>{assert.deepEqual(await snapshots.listIds(signal),[]);order.push('image');await removeImage(...args);};
  intents.acknowledge=async(...args)=>{assert.deepEqual(await images.listIds(signal),[]);order.push('intent');await ack(...args);};
  await retireMetadataScan(f.options);assert.deepEqual(order,['snapshot','image','intent']);assert.equal(intents.unresolved().length,0);const release=cache.guardThumbnailRetirement(intent.bundleId);release();release();
 }finally{await f.close();}
});
test('retirement can resume after restart between stores without losing unresolved evidence',async()=>{
 for(const phase of ['image','intent']){
  const f=await fixture();try{
   if(phase==='image')f.options.images.remove=async()=>{throw new Error('injected stop before image removal');};else f.options.intents.acknowledge=async()=>{throw new Error('injected stop before intent confirmation');};
   await assert.rejects(retireMetadataScan(f.options),/injected stop/);assert.deepEqual(await f.options.snapshots.listIds(signal),[]);assert.equal(f.options.intents.unresolved().length,1);assert.equal((await f.options.images.listIds(signal)).length,phase==='image'?1:0);
   await f.options.snapshots.close();await f.options.images.close();await f.options.intents.close();const snapshots=await MetadataSnapshots.open(join(f.dir,'snapshots')),images=await ThumbnailStorage.open(join(f.dir,'images')),intents=await MetadataScanIntents.open(join(f.dir,'intents'));
   try{await retireMetadataScan({...f.options,snapshots,images,intents,intent:intents.unresolved()[0]});assert.deepEqual(await snapshots.listIds(signal),[]);assert.deepEqual(await images.listIds(signal),[]);assert.equal(intents.unresolved().length,0);}finally{await snapshots.close();await images.close();await intents.close();}
  }finally{await f.close();}
 }
});
test('pre-cancelled retirement does not mutate storage and releases no nonexistent guard',async()=>{
 const f=await fixture();try{await assert.rejects(retireMetadataScan({...f.options,signal:AbortSignal.abort(new Error('cancel retirement'))}),/cancel retirement/);assert.equal(f.options.intents.unresolved().length,1);const release=f.options.cache.guardThumbnailRetirement(f.options.intent.bundleId);release();}finally{await f.close();}
});
