import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import sharp from 'sharp';
import {graphstatsFixture} from './graphstats-reference.ts';
import {readStatsFile,writeStatsPlot} from '../src/diagnostics/graphstats-file.ts';
import {systemStatsPlot} from '../src/diagnostics/graphstats.ts';
const dir=await mkdtemp(join(tmpdir(),'graph-export-bench-')),input=join(dir,'log.txt'),text=graphstatsFixture(10000),signal=new AbortController().signal,results=[];const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[Math.floor(v.length/2)],p95Ms:v[Math.ceil(v.length*.95)-1]};};
try{await writeFile(input,text);for(const format of ['svg','png']){const samples:number[]=[];for(let i=0;i<16;i++){const at=performance.now(),data=await readStatsFile(input,undefined,signal),plot=systemStatsPlot(data),output=join(dir,'plot.'+format);await writeStatsPlot(plot,output,signal);if(i>=5)samples.push(performance.now()-at);if(format==='png'){const metadata=await sharp(output).metadata();assert.equal(metadata.width,800);assert.equal(metadata.height,600);}}results.push({format,...stats(samples)});}await copyFile(join(dir,'plot.png'),'/tmp/graphstats-export-review.png');console.log(JSON.stringify({node:process.version,samples:10000,inputBytes:Buffer.byteLength(text),warmups:5,runs:11,results,scope:'Standalone Node diagnostic file read, strict decoding, parsing, system curve calculation, SVG generation, optional PNG rasterization and atomic file replacement. Decode validation outside timers. No Python renderer comparison, GUI or printer timing claim.'},null,2));}finally{await rm(dir,{recursive:true,force:true});}
