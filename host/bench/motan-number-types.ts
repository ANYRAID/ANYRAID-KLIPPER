import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {parseMotanJson,encodeMotanJson} from '../src/motan/capture.ts';
const dir=await mkdtemp(join(tmpdir(),'motan-json-bench-'));
try{
 // Run the actual preceding revision's parser, with its unchanged dependencies.
 const origin=new URL('../src/motan/capture.ts',import.meta.url);
 const source=execFileSync('git',['show','d955bc66:host/src/motan/capture.ts'],{encoding:'utf8'}).replace(/from '([^']+)'/g,(whole,spec:string)=>spec.startsWith('.')?`from '${new URL(spec,origin).href}'`:whole);
 const path=join(dir,'baseline.mts');await writeFile(path,source);
 const baseline=(await import(pathToFileURL(path).href)).parseMotanJson as (raw:Uint8Array)=>unknown;
 const inputs={
  status:encodeMotanJson({q:'status',params:{status:{toolhead:{estimated_print_time:12.5},sensor:Object.fromEntries(Array.from({length:64},(_,i)=>['field'+i,i/8]))}}}),
  sensor:encodeMotanJson({q:'accelerometer:a',params:{data:Array.from({length:4096},(_,i)=>[i/1000,Math.sin(i),i])}}),
  wide:encodeMotanJson({q:'status',params:{status:{sensor:{clock:9007199254740993n,value:42,float:1.25}}}}),
 };
 for(const [kind,raw]of Object.entries(inputs))for(const mode of ['baseline','default','typed']){
  const parse=mode==='baseline'?baseline:mode==='typed'?(raw:Uint8Array)=>parseMotanJson(raw,true):parseMotanJson;
  const expected=baseline(raw),ms:number[]=[];let last:unknown;
  for(let round=0;round<9;round++){
   const start=performance.now();for(let i=0;i<100;i++)last=parse(raw);
   const elapsed=(performance.now()-start)/100;assert.deepEqual(last,expected);if(round>=2)ms.push(elapsed);
  }
  ms.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,kind,mode,bytes:raw.length,msPerParse:{median:ms[3],p95BatchMean:ms[6]},valuesExact:true}));
 }
}finally{await rm(dir,{recursive:true,force:true});}
