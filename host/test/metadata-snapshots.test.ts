import {spawn} from 'node:child_process';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,chmod,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {MetadataSnapshots,restoreMetadataSnapshot} from '../src/moonraker/metadata-snapshots.ts';
import {MetadataScanIntents} from '../src/moonraker/metadata-intents.ts';
import {ThumbnailStorage} from '../src/moonraker/thumbnail-storage.ts';
import {FileMetadataStore} from '../src/moonraker/file-metadata.ts';
const signal=new AbortController().signal,source={dev:1n,ino:9007199254740993n,mtimeNs:-12345678901n,ctimeNs:1789832000000000000n};
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'metadata-snapshot-')),snapshots=await MetadataSnapshots.open(join(dir,'snapshots')),intents=await MetadataScanIntents.open(join(dir,'intents')),images=await ThumbnailStorage.open(join(dir,'images')),intent=await intents.begin('folder/part.gcode',signal);return {dir,snapshots,intents,images,intent,close:async()=>{await snapshots.close();await intents.close();await images.close();await rm(dir,{recursive:true,force:true});}};}
test('snapshot round trip preserves exact source integers and immutable fields',async()=>{
 const f=await fixture();try{
  const fields={size:7,modified:-12.345678901,thumbnails:[],filament_colors:['red']},saved=await f.snapshots.put(f.intent,source,fields,signal);fields.filament_colors[0]='blue';assert.equal(saved.source.ino,'9007199254740993');assert.equal(saved.source.mtimeNs,'-12345678901');assert.deepEqual(saved.fields.filament_colors,['red']);assert.throws(()=>{(saved.fields.filament_colors as string[])[0]='green';});await f.snapshots.close();const reopened=await MetadataSnapshots.open(join(f.dir,'snapshots'));
  try{assert.deepEqual(await reopened.listIds(signal),[saved.id]);assert.deepEqual(await reopened.read(saved.id,signal),saved);const cache=new FileMetadataStore();assert.equal(await restoreMetadataSnapshot(reopened,saved.id,cache,cache.begin(f.intent.filename),f.images,async fingerprint=>{assert.deepEqual(fingerprint,source);return true;},signal),true);assert.equal(cache.metadata(f.intent.filename).size,7);}finally{await reopened.close();}
 }finally{await f.close();}
});
test('restore validates every image reference and rejects absent, foreign or stale sources',async()=>{
 const f=await fixture();try{
  const bytes=await sharp({create:{width:32,height:32,channels:3,background:'red'}}).png().toBuffer(),bundle=await f.images.publish(f.intent.bundleId,[{bytes,width:32,height:32,format:'png',miniature:true}],signal),saved=await f.snapshots.put(f.intent,source,{size:7,modified:1,thumbnails:bundle.thumbnails},signal),cache=new FileMetadataStore();
  assert.equal(await restoreMetadataSnapshot(f.snapshots,saved.id,cache,cache.begin(f.intent.filename),f.images,async()=>true,signal),true);
  await assert.rejects(restoreMetadataSnapshot(f.snapshots,saved.id,cache,cache.begin('wrong.gcode'),f.images,async()=>true,signal),(e:any)=>e.status===409);
  await assert.rejects(restoreMetadataSnapshot(f.snapshots,saved.id,cache,cache.begin(f.intent.filename),f.images,async()=>false,signal),(e:any)=>e.status===409);assert.equal(cache.peek(f.intent.filename),undefined);
  await f.images.remove(f.intent.bundleId,signal);await assert.rejects(restoreMetadataSnapshot(f.snapshots,saved.id,cache,cache.begin(f.intent.filename),f.images,async()=>true,signal));assert.equal(cache.peek(f.intent.filename),undefined);
 }finally{await f.close();}
});
test('restore never replaces a newer ticket, including during source validation',async()=>{
 const f=await fixture();try{const saved=await f.snapshots.put(f.intent,source,{size:7,modified:1,thumbnails:[]},signal),cache=new FileMetadataStore(),ticket=cache.begin(f.intent.filename);assert.equal(await restoreMetadataSnapshot(f.snapshots,saved.id,cache,ticket,f.images,async()=>{cache.commit(cache.begin(f.intent.filename),{size:99});return true;},signal),false);assert.equal(cache.metadata(f.intent.filename).size,99);}finally{await f.close();}
});
test('invalid references reject before publication, duplicate writes retain original snapshot',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.snapshots.put(f.intent,source,{size:1,modified:1,thumbnails:[{width:32,height:32,size:100,relative_path:'.thumbs/foreign/0.png'}]},signal),/reference/);assert.equal(f.snapshots.status.faulted,false);assert.deepEqual(await f.snapshots.listIds(signal),[]);
  const saved=await f.snapshots.put(f.intent,source,{size:1,modified:1,thumbnails:[]},signal);await assert.rejects(f.snapshots.put(f.intent,source,{size:2,modified:2,thumbnails:[]},signal),/recovery/);assert.equal(f.snapshots.status.faulted,true);await f.snapshots.close();const recovered=await MetadataSnapshots.open(join(f.dir,'snapshots'));try{assert.equal((await recovered.read(saved.id,signal)).fields.size,1);}finally{await recovered.close();}
 }finally{await f.close();}
});
test('corrupt snapshot is discovered on verified read rather than restored to cache',async()=>{
 const f=await fixture();try{const saved=await f.snapshots.put(f.intent,source,{size:1,modified:1,thumbnails:[]},signal);await f.snapshots.close();const path=join(f.dir,'snapshots',(await readdir(join(f.dir,'snapshots'))).find(name=>name.endsWith('.gcode'))!),bytes=await readFile(path);bytes[0]^=1;await chmod(path,0o600);await writeFile(path,bytes);const recovered=await MetadataSnapshots.open(join(f.dir,'snapshots'));try{await assert.rejects(recovered.read(saved.id,signal),/digest/);}finally{await recovered.close();}}finally{await f.close();}
});

test('snapshot and source integers survive SIGKILL without closing their owner',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'snapshot-crash-'));try{
  const intentsUrl=new URL('../src/moonraker/metadata-intents.ts',import.meta.url).href,snapshotsUrl=new URL('../src/moonraker/metadata-snapshots.ts',import.meta.url).href;
  const code=`import {MetadataScanIntents} from ${JSON.stringify(intentsUrl)};import {MetadataSnapshots} from ${JSON.stringify(snapshotsUrl)};const intents=await MetadataScanIntents.open(process.argv[1]+'/intents'),snapshots=await MetadataSnapshots.open(process.argv[1]+'/snapshots'),intent=await intents.begin('p.gcode',new AbortController().signal);const saved=await snapshots.put(intent,{dev:1n,ino:9007199254740993n,mtimeNs:-12345678901n,ctimeNs:1789832000000000000n},{size:1,modified:1,thumbnails:[]},new AbortController().signal);await new Promise(resolve=>process.stdout.write(saved.id,resolve));process.kill(process.pid,'SIGKILL');`;
  const id=await new Promise<string>((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',code,dir],{stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>errors+=data);child.on('error',reject);child.on('close',(_code,signal)=>signal==='SIGKILL'?resolve(output):reject(new Error(errors)));});
  const snapshots=await MetadataSnapshots.open(join(dir,'snapshots'));try{const saved=await snapshots.read(id,signal);assert.equal(saved.source.ino,'9007199254740993');assert.equal(saved.source.mtimeNs,'-12345678901');assert.equal(saved.fields.size,1);}finally{await snapshots.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
