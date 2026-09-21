import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {mkdtemp,rm,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {simulateShaper} from '../src/diagnostics/graph-shaper.ts';
import {writeStatsPanels} from '../src/diagnostics/graphstats-file.ts';
const dir=await mkdtemp(join(tmpdir(),'shaper-export-bench-')),results=[],signal=new AbortController().signal;
try{for(const format of ['svg','png']){const samples:number[]=[];for(let i=0;i<16;i++){const start=performance.now(),model=simulateShaper(),path=join(dir,'plot.'+format);await writeStatsPanels([{plot:model.frequency,xAxis:{label:'Resonance frequency (Hz)',format:'number'}},{plot:model.step,xAxis:{label:'Time (s)',format:'number'}}],path,signal);if(i>=5)samples.push(performance.now()-start);if(format==='png'){const meta=await sharp(path).metadata();assert.equal(meta.width,800);assert.equal(meta.height,1200);}}samples.sort((a,b)=>a-b);results.push({format,medianMs:samples[5],p95Ms:samples[10]});}await copyFile(join(dir,'plot.png'),'/tmp/shaper-export-review.png');console.log(JSON.stringify({node:process.version,warmups:5,runs:11,results,scope:'Default MZV simulation, both SVG panels, optional PNG encoding and atomic replacement. Decode verification outside timing. No Python renderer, process startup or hardware comparison.'},null,2));}finally{await rm(dir,{recursive:true,force:true});}
