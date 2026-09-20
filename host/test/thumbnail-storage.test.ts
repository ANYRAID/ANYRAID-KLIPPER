import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,chmod,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {ThumbnailStorage,publishThumbnailMetadata} from '../src/moonraker/thumbnail-storage.ts';
import {FileMetadataStore} from '../src/moonraker/file-metadata.ts';
import type {ThumbnailImage} from '../src/moonraker/thumbnail-images.ts';
const signal=()=>new AbortController().signal;
async function fixture(options:Parameters<typeof ThumbnailStorage.open>[1]={}){const directory=await mkdtemp(join(tmpdir(),'thumbnail-storage-')),root=join(directory,'store'),store=await ThumbnailStorage.open(root,options);return {directory,root,store,async close(){await store.close();await rm(directory,{recursive:true,force:true});}};}
async function images():Promise<ThumbnailImage[]>{return Promise.all([32,64].map(async size=>({width:size,height:size,format:'png' as const,miniature:size===32,bytes:await sharp({create:{width:size,height:size,channels:3,background:size===32?'red':'blue'}}).png().toBuffer()})));}
test('atomic thumbnail sets survive restart and return independent binary image snapshots',async()=>{
 const f=await fixture(),id=ThumbnailStorage.newId(),input=await images();try{const metadata=await f.store.publish(id,input,signal());assert.equal(metadata.thumbnails.length,2);assert.equal(f.store.status.staging.reservations,0);assert.equal((await readdir(f.root)).filter(n=>n.endsWith('.json')).length,1);const first=await f.store.read(id,0,signal());assert.deepEqual(first.bytes,input[0].bytes);first.bytes.fill(0);assert.deepEqual((await f.store.read(id,0,signal())).bytes,input[0].bytes);
  await f.store.close();const recovered=await ThumbnailStorage.open(f.root);try{assert.deepEqual(await recovered.inspect(id,signal()),metadata);assert.deepEqual((await recovered.read(id,1,signal())).bytes,input[1].bytes);}finally{await recovered.close();}
 }finally{await f.close();}
});
test('publication is immutable and quotas leave no partial metadata or staging leases',async()=>{
 const f=await fixture(),input=await images(),id=ThumbnailStorage.newId();try{await f.store.publish(id,input,signal());await assert.rejects(f.store.publish(id,[input[0]],signal()),/exists/);assert.equal((await f.store.inspect(id,signal())).thumbnails.length,2);assert.equal(f.store.status.staging.reservations,0);await assert.rejects(f.store.publish('../escape',input,signal()),/identifier/);await assert.rejects(f.store.publish(ThumbnailStorage.newId(),[],signal()),/images/);}finally{await f.close();}
 const small=await fixture({maxStorageBytes:100});try{await assert.rejects(small.store.publish(ThumbnailStorage.newId(),input,signal()),/quota/);assert.deepEqual(await readdir(small.root),[]);assert.equal(small.store.status.staging.reservations,0);}finally{await small.close();}
});
test('stale cache tickets remove the new bundle without touching newer metadata',async()=>{
 const f=await fixture(),cache=new FileMetadataStore(),input=await images(),id=ThumbnailStorage.newId();try{const ticket=cache.begin('part.gcode'),pending=publishThumbnailMetadata(f.store,cache,ticket,{size:1},id,input,signal());cache.commit(cache.begin('part.gcode'),{size:99});assert.equal(await pending,false);assert.equal(cache.metadata('part.gcode').size,99);assert.equal(f.store.status.storage.publishedFiles,0);assert.deepEqual(await readdir(f.root),[]);
  const current=cache.begin('part.gcode');assert.equal(await publishThumbnailMetadata(f.store,cache,current,{size:2},ThumbnailStorage.newId(),input,signal()),true);assert.equal(cache.thumbnails('part.gcode').length,2);
 }finally{await f.close();}
});
test('cache validation failure rolls back a completed bundle, while cancelled admission preserves prior records',async()=>{
 const f=await fixture(),cache=new FileMetadataStore({maxRecordBytes:1}),input=await images();try{await assert.rejects(publishThumbnailMetadata(f.store,cache,cache.begin('p.gcode'),{size:1},ThumbnailStorage.newId(),input,signal()),/limit/);assert.equal(f.store.status.storage.publishedFiles,0);assert.equal(cache.peek('p.gcode'),undefined);await assert.rejects(f.store.publish(ThumbnailStorage.newId(),input,AbortSignal.abort(new Error('cancel'))),/cancel/);assert.equal(f.store.status.staging.reservations,0);}finally{await f.close();}
});
test('concurrent deletion cannot repopulate the verified read cache with a retired bundle',async()=>{
 const f=await fixture(),input=await images(),id=ThumbnailStorage.newId();try{await f.store.publish(id,input,signal());const reading=f.store.read(id,0,signal()),removing=f.store.remove(id,signal());assert.deepEqual((await reading).bytes,input[0].bytes);await removing;assert.equal(f.store.status.cachedBundles,0);assert.equal(f.store.status.cacheBytes,0);await assert.rejects(f.store.read(id,0,signal()),/ENOENT/);assert.deepEqual(await readdir(f.root),[]);}finally{await f.close();}
});
test('uncached binary reads reject corrupt content and cache size stays bounded',async()=>{
 const f=await fixture({maxCacheBytes:0}),input=await images(),id=ThumbnailStorage.newId();try{await f.store.publish(id,input,signal());await f.store.read(id,0,signal());assert.equal(f.store.status.cacheBytes,0);const blob=(await readdir(f.root)).find(n=>n.endsWith('.gcode'))!,path=join(f.root,blob),bytes=await readFile(path);bytes[bytes.length-1]^=1;await chmod(path,0o600);await writeFile(path,bytes);await assert.rejects(f.store.read(id,1,signal()),/digest mismatch/);}finally{await f.close();}
 const bounded=await fixture({maxCacheBytes:1024});try{for(let i=0;i<4;i++){const next=ThumbnailStorage.newId();await bounded.store.publish(next,input,signal());await bounded.store.inspect(next,signal());assert.ok(bounded.store.status.cacheBytes<=1024);}}finally{await bounded.close();}
});
test('close drains accepted publication before releasing the exclusive store lock',async()=>{
 const f=await fixture(),input=await images(),id=ThumbnailStorage.newId();try{const publishing=f.store.publish(id,input,signal()),closing=f.store.close();assert.equal((await publishing).id,id);await closing;assert.equal(f.store.status.cacheBytes,0);await assert.rejects(f.store.read(id,0,signal()),/closed/);const recovered=await ThumbnailStorage.open(f.root);try{assert.equal((await recovered.inspect(id,signal())).thumbnails.length,2);}finally{await recovered.close();}}finally{await f.close();}
});
