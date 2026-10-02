import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildMotan} from '../scripts/build-motan.ts';
import {managerFixture} from '../test/helpers/motan-manager-fixture.ts';
import {parseTypedMotanJson} from '../src/motan/number-types.ts';
import {legacyMotanCsv,motanExportReferenceMetadata} from '../test/helpers/motan-export-reference.ts';
import {csvRows,csvBits} from '../test/helpers/motan-csv-reference.ts';
const root=fileURLToPath(new URL('../../',import.meta.url)),build=join(root,'host/build');await mkdir(build,{recursive:true});
const dir=await mkdtemp(join(build,'.motan-compiled-bench-')),output=join(dir,'app');
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {median:values[Math.floor(values.length/2)],p95:values[Math.ceil(values.length*.95)-1]};};
const env:NodeJS.ProcessEnv={...process.env,PATH:'/no-programs',NODE_DISABLE_COMPILE_CACHE:'1'};delete env.NODE_COMPILE_CACHE;
try{
 const start=performance.now();await buildMotan(output);console.log(JSON.stringify({node:process.version,buildMs:performance.now()-start,buildExcludedFromExport:true,reference:'frozen '+motanExportReferenceMetadata.historicalPerformance.environment.python}));
 for(const shape of ['empty','scalar','structured']){
  const prefix=join(dir,shape),duration=shape==='empty'?'0':'20';
  const fields=parseTypedMotanJson('{"value":'+(shape==='structured'?' {"2":['+Array.from({length:32},(_,i)=>String(i)+(i%2?'.0':'')).join(',')+'],"1":"雪😀, quote\\\""}':'123.0')+'}') as Record<string,unknown>;
  await managerFixture(prefix,10,'corexy',fields);
  const common=[prefix,'-c','["status(export_fields.value)"]','-d',duration,'--segment-time','.001'],reference=legacyMotanCsv(common);
  const samples={source:[] as number[],compiled:[] as number[]},outputs:Record<string,string>={};
  for(let run=0;run<18;run++)for(const mode of run%2?['compiled','source'] as const:['source','compiled'] as const){
   const entry=mode==='compiled'?join(output,'scripts/motan/data_export.js'):join(root,'scripts/motan/data_export.ts');
   const args=[...mode==='compiled'?['--no-experimental-strip-types']:[],entry,...common,'--preserve-number-types'];
   const start=performance.now();outputs[mode]=execFileSync(process.execPath,args,{env,encoding:'utf8',timeout:30000,maxBuffer:32*1024**2});if(run>=3)samples[mode].push(performance.now()-start);
   if(mode==='compiled'&&outputs.source!==undefined)assert.equal(outputs.compiled,outputs.source);
  }
  assert.equal(outputs.compiled,outputs.source);
  const [actual,expected]=[outputs.compiled,reference].map(csvRows);assert.deepEqual(actual[0],expected[0]);assert.equal(actual.length,expected.length);
  for(let i=1;i<actual.length;i++){assert.equal(csvBits(actual[i][0]),csvBits(expected[i][0]));if(shape==='structured')assert.deepEqual(actual[i].slice(1),expected[i].slice(1));else assert.equal(csvBits(actual[i][1]),csvBits(expected[i][1]));}
  const historical=motanExportReferenceMetadata.historicalPerformance.cases.find((row:{shape:string})=>row.shape===shape);assert(historical);
  console.log(JSON.stringify({shape,rows:shape==='empty'?0:20000,scope:'Fresh Node process and worker, gzip, sampling, CSV, stdout; no Python process; V8/TS compile cache disabled; OS caches not cleared; 3 warmups/15 alternating runs',sourceMs:stats(samples.source),compiledMs:stats(samples.compiled),historicalPythonMs:historical.pythonMs,sourceByteExact:true,pythonValuesExact:true}));
 }
}finally{await rm(dir,{recursive:true,force:true});}
