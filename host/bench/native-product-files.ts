import {mkdtemp,rm,writeFile,open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {NativeProductFileResources} from '../src/runtime/native-product-machine.ts';
/** Same cached filesystem, catalog, receipts and content. Measures the file
 * ownership transition only; does not measure MCU restart or print speed. */
const dir=await mkdtemp(join(tmpdir(),'process-file-bench-')),options={filesRoot:join(dir,'files'),metadataRoot:join(dir,'metadata')},signal=new AbortController().signal;
const count=256,iterations=10,input='G1 X1 F600\n',sourcePath=join(dir,'source');
let seed:PublishedPrintFiles|undefined,source:Awaited<ReturnType<typeof open>>|undefined,resources:NativeProductFileResources|undefined;
const blocks:{mode:'reopen'|'retained';coldOpenMs?:number;samplesMs:number[]}[]=[];
try{
 await writeFile(sourcePath,input);source=await open(sourcePath,'r');seed=await PublishedPrintFiles.open(options.filesRoot);
 for(let i=0;i<count;i++)await seed.publish('file-'+i,'part-'+i+'.gcode',source,signal);
 await seed.close();seed=undefined;await source.close();source=undefined;
 // Warm the kernel page cache without retaining a directory lock.
 for(let i=0;i<2;i++){const store=await PublishedPrintFiles.open(options.filesRoot);try{assert.equal((await store.catalog(signal)).length,count);}finally{await store.close();}}
 for(const mode of ['reopen','retained','retained','reopen','reopen','retained','retained','reopen'] as const){
  const block:typeof blocks[number]={mode,samplesMs:[]};
  if(mode==='retained'){const begin=performance.now();resources=await NativeProductFileResources.open(options);block.coldOpenMs=performance.now()-begin;}
  for(let i=0;i<iterations;i++){
   const begin=performance.now();
   if(resources){const lease=resources.acquire(options);try{assert.equal((await lease.files.catalog(signal)).length,count);}finally{lease.release();}}
   else{const store=await PublishedPrintFiles.open(options.filesRoot);try{assert.equal((await store.catalog(signal)).length,count);}finally{await store.close();}}
   block.samplesMs.push(performance.now()-begin);
  }
  await resources?.close();resources=undefined;blocks.push(block);
 }
 const summarize=(mode:typeof blocks[number]['mode'])=>{const values=blocks.filter(b=>b.mode===mode).flatMap(b=>b.samplesMs).sort((a,b)=>a-b);return {samples:values.length,medianMs:values[Math.floor(values.length*.5)],p95Ms:values[Math.floor(values.length*.95)],p99Ms:values[Math.floor(values.length*.99)]};};
 console.log(JSON.stringify({node:process.version,scope:'File generation acquisition/catalog/release on cached local storage. Cold initial process opens excluded from retained samples and reported separately. No motion or hardware performance claim.',files:count,inputSha256:createHash('sha256').update(input).digest('hex'),order:'ABBA ABBA',reopen:summarize('reopen'),retained:summarize('retained'),blocks},null,2));
}finally{await source?.close();await seed?.close();await resources?.close();await rm(dir,{recursive:true,force:true});}
