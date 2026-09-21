import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import sharp from 'sharp';
import {ThumbnailStorage} from '../src/moonraker/thumbnail-storage.ts';
const dir=await mkdtemp(join(tmpdir(),'thumbnail-inventory-')),signal=new AbortController().signal;
let store:ThumbnailStorage|undefined;
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[5],p95Ms:values[10]};};
try{
 store=await ThumbnailStorage.open(dir);const bytes=await sharp({create:{width:32,height:32,channels:3,background:'red'}}).png().toBuffer(),expected:string[]=[];
 for(let i=0;i<1024;i++){const id=ThumbnailStorage.newId();expected.push(id);await store.publish(id,[{bytes,width:32,height:32,format:'png',miniature:true}],signal);}expected.sort();await store.close();const start=performance.now();store=await ThumbnailStorage.open(dir);const recoveryMs=performance.now()-start;
 const inventory:number[]=[],directory:number[]=[];for(let i=0;i<16;i++){let at=performance.now();for(let n=0;n<100;n++)assert.equal((await store.listIds(signal)).length,expected.length);if(i>=5)inventory.push(performance.now()-at);at=performance.now();for(let n=0;n<100;n++)assert.equal((await readdir(dir)).filter(name=>name.endsWith('.json')).sort().length,expected.length);if(i>=5)directory.push(performance.now()-at);}
 assert.deepEqual(await store.listIds(signal),expected);assert.equal(store.status.cachedBundles,0);
 console.log(JSON.stringify({node:process.version,receipts:1024,warmups:5,runs:11,callsPerSample:100,recoveryMs,inventory:stats(inventory),plainDirectoryReadReference:stats(directory),cachedBundles:store.status.cachedBundles,scope:'Inventory after real receipt recovery; no image decode or deletion. Plain directory reference lacks mutation ordering and receipt validation. Not a Python or printing-throughput comparison.'},null,2));
}finally{await store?.close();await rm(dir,{recursive:true,force:true});}
