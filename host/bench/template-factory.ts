import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {MoonrakerTemplateFactory} from '../src/moonraker/template-factory.ts';
const bytes=await readFile(new URL('../contracts/moonraker-template-factory-reference.json',import.meta.url)),referenceSha256='721c0483ce20450e2f95f4abf1629d5101bfdc97cffb97c8ae3653ece0e104b0';
if(createHash('sha256').update(bytes).digest('hex')!==referenceSha256)throw Error('Frozen factory reference mismatch');
const reference=JSON.parse(bytes.toString()) as {secrets:string;benchmarks:{name:string;kind:string;source:string;context:string;iterations:number;warmups:number;samples:number;medianMs:number;maximumMedianRatio:number}[]};
const root=await mkdtemp(join(tmpdir(),'factory-benchmark-')),results=[];let factory:MoonrakerTemplateFactory|undefined;
try{
 await writeFile(join(root,'moonraker.secrets'),reference.secrets);factory=await MoonrakerTemplateFactory.load(new ConfigurationReader(new ConfigurationSource('/synthetic/factory-benchmark',{server:{}},[])),{dataPath:root});
 for(const row of reference.benchmarks){const handle=row.kind==='ui'?factory.createUiTemplate(row.source):factory.createTemplate(row.source,row.kind==='async');
  const batch=async()=>{if(row.kind==='sync'){for(let i=0;i<row.iterations;i++)if(handle.render(row.context)!=='3')throw Error('Factory benchmark output mismatch');}else{for(let i=0;i<row.iterations;i++)if(await handle.renderAsync(row.context)!=='3')throw Error('Factory benchmark output mismatch');}};
  for(let i=0;i<row.warmups;i++)await batch();const sampleMs=[];for(let i=0;i<row.samples;i++){const start=performance.now();await batch();sampleMs.push(performance.now()-start);}
  const medianMs=[...sampleMs].sort((a,b)=>a-b)[Math.floor(sampleMs.length/2)]!,ratio=medianMs/row.medianMs;
  results.push({name:row.name,iterations:row.iterations,warmups:row.warmups,samples:row.samples,sampleMs,medianMs,referenceMedianMs:row.medianMs,ratio,maximumMedianRatio:row.maximumMedianRatio,pass:ratio<=row.maximumMedianRatio});handle.close();
 }
}finally{factory?.close();await rm(root,{recursive:true,force:true});}
console.log(JSON.stringify({schema:1,node:process.version,referenceSha256,results,pass:results.every(row=>row.pass),scope:'Fixed desktop shared-factory rendering only; not target-board printing, complete language compatibility or cold service assembly.'},null,2));if(results.some(row=>!row.pass))process.exitCode=1;
