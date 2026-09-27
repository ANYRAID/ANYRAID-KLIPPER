import {fatDisk} from './helpers/fatfs-disk.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {FatFS,FatFSError} from '../src/diagnostics/fatfs.ts';

const signal=()=>new AbortController().signal;
test('isolated FatFs writes, closes, remounts, reads and removes real FAT16 files',async t=>{
 const d=fatDisk();let fs=await FatFS.mount(d.device,signal());try{
  await assert.rejects(fs.stat('missing.bin',signal()),e=>e instanceof FatFSError&&e.code===4);
  const bytes=Buffer.from(Array.from({length:131071},(_,i)=>(i*73)&255));const start=performance.now();await fs.writeFile('firmware.bin',bytes,signal());const elapsed=performance.now()-start;
  assert.equal((await fs.stat('firmware.bin',signal())).size,bytes.length);await fs.close();fs=await FatFS.mount(d.device,signal());assert.deepEqual(await fs.readFile('firmware.bin',signal()),bytes);
  await fs.writeFile('long firmware filename.bin',Buffer.from('new firmware'),signal());assert.equal((await fs.readFile('long firmware filename.bin',signal())).toString(),'new firmware');await fs.remove('firmware.bin',signal());await assert.rejects(fs.stat('firmware.bin',signal()),e=>e instanceof FatFSError&&e.code===4);
  t.diagnostic(JSON.stringify({bytes:bytes.length,writeMs:elapsed,sectorWrites:d.writes,scope:'Native FatFs helper with memory FAT16 block device; includes process IPC but excludes card latency'}));
 }finally{await fs.close();}
});
test('separate FatFs processes isolate volumes and reject protected disk writes',async()=>{
 const a=fatDisk(),b=fatDisk(),one=await FatFS.mount(a.device,signal()),two=await FatFS.mount(b.device,signal());try{await Promise.all([one.writeFile('fw.bin',Buffer.from('a'),signal()),two.writeFile('fw.bin',Buffer.from('b'),signal())]);assert.equal((await one.readFile('fw.bin',signal())).toString(),'a');assert.equal((await two.readFile('fw.bin',signal())).toString(),'b');}finally{await Promise.all([one.close(),two.close()]);}
 b.device.writeProtected=true;const ro=await FatFS.mount(b.device,signal());try{const count=b.writes;await assert.rejects(ro.writeFile('fw.bin',Buffer.from('c'),signal()));assert.equal(b.writes,count);}finally{await ro.close();}
});
test('FatFs cancellation and invalid geometry never continue sector writes',async()=>{
 const d=fatDisk();await assert.rejects(FatFS.mount({...d.device,sectors:2**32},signal()),/geometry/);
 const fs=await FatFS.mount(d.device,signal());try{assert.throws(()=>fs.readFile('../fw.bin',signal()),/path/);await assert.rejects(fs.writeFile('fw.bin',new Uint8Array(512),AbortSignal.abort(new Error('cancel'))),/cancel/);assert.equal(d.writes,0);}finally{await fs.close();}
});
test('FatFs full disk never returns successful short write',async()=>{
 const d=fatDisk(),fs=await FatFS.mount(d.device,signal());try{await assert.rejects(fs.writeFile('full.bin',new Uint8Array(5*1024*1024),signal()),e=>e instanceof FatFSError&&e.code===7);assert((await fs.stat('full.bin',signal())).size<5*1024*1024);}finally{await fs.close();}
});
test('FatFs failed block IO closes helper and rejects queued work',async()=>{
 const d=fatDisk();d.device.writeSector=async()=>{throw new Error('media failure');};const fs=await FatFS.mount(d.device,signal());try{const write=fs.writeFile('fw.bin',new Uint8Array(512),signal()),next=fs.readFile('fw.bin',signal());const results=await Promise.allSettled([write,next]);assert(results.every(r=>r.status==='rejected'));assert.match(String((results[0] as PromiseRejectedResult).reason),/media failure/);}finally{await fs.close();}
});
test('closing FatFs aborts outstanding block callback before resolving cleanup',async()=>{
 const d=fatDisk(),entered=Promise.withResolvers<void>();d.device.writeSector=async(_sector,_bytes,s)=>{entered.resolve();await new Promise<void>((_resolve,reject)=>{s.addEventListener('abort',()=>reject(s.reason),{once:true});});};const fs=await FatFS.mount(d.device,signal());
 const write=fs.writeFile('fw.bin',new Uint8Array(512),signal()),failed=assert.rejects(write,/closed/);await entered.promise;await fs.close();await failed;
});
