import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {MotanStallguardSampler,type MotanStallguardRow} from '../src/motan/diagnostic-samples.ts';
import {parseTypedMotanJson} from '../src/motan/number-types.ts';
import {stallguardOracle} from '../test/helpers/motan-diagnostic-oracle.ts';
import {managerFixture} from '../test/helpers/motan-manager-fixture.ts';
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {median:a[Math.floor(a.length/2)],p95:a[Math.ceil(a.length*.95)-1]};};
const dir=await mkdtemp(join(tmpdir(),'motan-stallguard-bench-')),root=fileURLToPath(new URL('../../',import.meta.url));
try{
 const path=join(dir,'baseline.mts'),origin=new URL('../src/motan/diagnostic-samples.ts',import.meta.url);
 await writeFile(path,execFileSync('git',['show','88a86262:host/src/motan/diagnostic-samples.ts'],{encoding:'utf8'}).replace(/from '([^']+)'/g,(whole,spec:string)=>spec.startsWith('.')?`from '${new URL(spec,origin).href}'`:whole));
 const baseline=await import(pathToFileURL(path).href);
 const blocks=Array.from({length:320},(_,b)=>({data:Array.from({length:64},(_,i):[number,number,number]=>[(b*64+i)/1000,(b*64+i)%1024,i%32])})),typed=blocks.map(b=>parseTypedMotanJson(JSON.stringify(b)) as {data:MotanStallguardRow[]}),times=Array.from({length:20000},(_,i)=>(i+.5)/1000);
 const reference=stallguardOracle(blocks,times,'sg_result',true),timings:Record<string,number[]>={old:[],current:[],typed:[]};
 for(let run=0;run<35;run++)for(const mode of run%2?['typed','current','old']:['old','current','typed']){
  let at=0;const source=mode==='typed'?typed:blocks,start=performance.now(),sampler=mode==='old'?new baseline.MotanStallguardSampler('sg_result',async()=>source[at++]??null):new MotanStallguardSampler('sg_result',async()=>source[at++]??null,mode==='typed'),actual=[];
  for(const time of times)actual.push(await sampler.sample(time));const elapsed=performance.now()-start;
  assert.deepEqual(actual.map(v=>v===null?null:Number(v)),reference.values);if(mode==='typed')assert.ok(actual.every(v=>v===null||typeof v==='bigint'));if(run>=20)timings[mode].push(elapsed);
 }
 console.log(JSON.stringify({scope:'20000 samples, 64 rows/block; validation, async sampling and results; excludes JSON/gzip/worker. Old source 88a86262. Node 20 warmups/15 runs; Python 2/7.',node:process.version,pythonMs:stats(reference.ms),oldMs:stats(timings.old),nodeMs:stats(timings.current),typedMs:stats(timings.typed),exact:true}));
 const prefix=join(dir,'log');await managerFixture(prefix,10);
 const columns=['stallguard(stepper_x,sg_result)'],outputs:string[]=[];
 for(const mode of ['python','node','typed']){
  const args=[join(root,`scripts/motan/data_export.${mode==='python'?'py':'ts'}`),prefix,'-c',JSON.stringify(columns),'-d','20','--segment-time','.001',...(mode==='typed'?['--preserve-number-types']:[])],ms:number[]=[];let output='';
  for(let run=0;run<9;run++){const start=performance.now();output=execFileSync(mode==='python'?'python3':process.execPath,args,{encoding:'utf8',maxBuffer:16*1024**2,timeout:30000});if(run>=2)ms.push(performance.now()-start);}
  outputs.push(output);console.log(JSON.stringify({scope:'20000 CSV samples including process startup, gzip, parsing, worker, analysis and stdout; 2 warmups/7 runs',mode,ms:stats(ms)}));
 }
 const rows=(text:string)=>text.trimEnd().split('\r\n').slice(1).map(line=>line.split(',').map(v=>v===''?null:Number(v)));assert.deepEqual(rows(outputs[1]),rows(outputs[0]));assert.deepEqual(rows(outputs[2]),rows(outputs[0]));console.log(JSON.stringify({csvNumericExact:true}));
}finally{await rm(dir,{recursive:true,force:true});}
