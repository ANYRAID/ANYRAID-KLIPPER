import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {temperaturePlots,temperatureGraphSensors} from '../src/diagnostics/graph-temperature.ts';
import {writeStatsPanels} from '../src/diagnostics/graphstats-file.ts';
const dir=await mkdtemp(join(tmpdir(),'interactive-bench-')),results=[];
try{
 for(const extension of ['svg','html']){
  const samples:number[]=[];let bytes=0;
  for(let i=0;i<16;i++){const start=performance.now(),panels=temperaturePlots();await writeStatsPanels(panels,join(dir,'plot.'+extension),new AbortController().signal);if(i>=5)samples.push(performance.now()-start);const text=await readFile(join(dir,'plot.'+extension),'utf8');bytes=Buffer.byteLength(text);assert.equal((text.match(/data-curve-label=/g)||[]).length,temperatureGraphSensors.length*2);if(extension==='html')assert(text.includes('Content-Security-Policy'));}
  samples.sort((a,b)=>a-b);const medianMs=samples[5],p95Ms=samples[10];assert(medianMs<100&&p95Ms<200,'Diagnostic export regression');results.push({extension,medianMs,p95Ms,bytes});
 }
 console.log(JSON.stringify({node:process.version,sensors:temperatureGraphSensors.length,warmup:5,samples:11,budgetMs:{median:100,p95:200},results,scope:'Full temperature computation, SVG/HTML construction and atomic write. Excludes browser load, paint, interaction latency and physical hardware.'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
