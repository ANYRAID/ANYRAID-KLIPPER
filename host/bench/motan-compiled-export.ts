import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildMotan} from '../scripts/build-motan.ts';
import {managerFixture} from '../test/helpers/motan-manager-fixture.ts';
import {parseTypedMotanJson} from '../src/motan/number-types.ts';
const root=fileURLToPath(new URL('../../',import.meta.url)),build=join(root,'host/build');await mkdir(build,{recursive:true});
const dir=await mkdtemp(join(build,'.motan-compiled-bench-')),output=join(dir,'app');
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {median:values[Math.floor(values.length/2)],p95:values[Math.ceil(values.length*.95)-1]};};
const env:NodeJS.ProcessEnv={...process.env,NODE_DISABLE_COMPILE_CACHE:'1'};delete env.NODE_COMPILE_CACHE;
try{
 const start=performance.now();await buildMotan(output);console.log(JSON.stringify({node:process.version,buildMs:performance.now()-start,buildExcludedFromExport:true,python:execFileSync('python3',['--version'],{encoding:'utf8'}).trim()}));
 for(const shape of ['empty','scalar','structured']){
  const prefix=join(dir,shape),duration=shape==='empty'?'0':'20';
  const fields=parseTypedMotanJson('{"value":'+(shape==='structured'?' {"2":['+Array.from({length:32},(_,i)=>String(i)+(i%2?'.0':'')).join(',')+'],"1":"雪😀, quote\\\""}':'123.0')+'}') as Record<string,unknown>;
  await managerFixture(prefix,10,'corexy',fields);
  const samples={source:[] as number[],compiled:[] as number[],python:[] as number[]},outputs:Record<string,string>={};
  for(let run=0;run<18;run++)for(const mode of run%2?['python','compiled','source'] as const:['source','compiled','python'] as const){
   const entry=mode==='compiled'?join(output,'scripts/motan/data_export.js'):join(root,`scripts/motan/data_export.${mode==='python'?'py':'ts'}`);
   const args=[...mode==='compiled'?['--no-experimental-strip-types']:[],entry,prefix,'-c','["status(export_fields.value)"]','-d',duration,'--segment-time','.001',...mode!=='python'?['--preserve-number-types']:[]];
   const start=performance.now();outputs[mode]=execFileSync(mode==='python'?'python3':process.execPath,args,{env,encoding:'utf8',timeout:30000,maxBuffer:32*1024**2});if(run>=3)samples[mode].push(performance.now()-start);
   if(mode==='compiled'&&outputs.source!==undefined)assert.equal(outputs.compiled,outputs.source);
  }
  assert.equal(outputs.compiled,outputs.source);
  const exact=execFileSync('python3',['-c',`import csv,io,json,sys,struct
x=json.load(sys.stdin);a,b=[list(csv.reader(io.StringIO(s,newline=''))) for s in x['outputs']]
assert a[0]==b[0] and len(a)==len(b)
for left,right in zip(a[1:],b[1:]):
 assert struct.pack('>d',float(left[0]))==struct.pack('>d',float(right[0]))
 if x['structured']: assert left[1:]==right[1:]
 else: assert float(left[1])==float(right[1])
print('exact')`],{input:JSON.stringify({outputs:[outputs.compiled,outputs.python],structured:shape==='structured'}),encoding:'utf8',timeout:30000,maxBuffer:32*1024**2});assert.equal(exact.trim(),'exact');
  console.log(JSON.stringify({shape,rows:shape==='empty'?0:20000,scope:'fresh process and worker, gzip, sampling, CSV, stdout; V8/TS compile cache disabled; OS caches not cleared; 3 warmups/15 alternating runs',sourceMs:stats(samples.source),compiledMs:stats(samples.compiled),pythonMs:stats(samples.python),sourceByteExact:true,pythonValuesExact:true}));
 }
}finally{await rm(dir,{recursive:true,force:true});}
