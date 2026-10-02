// GPL-3.0-or-later. Real capture -> worker analysis -> plot -> atomic export.
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {managerFixture} from '../test/helpers/motan-manager-fixture.ts';
import {MotanAnalysisExecutor} from '../src/motan/analysis-executor.ts';
import {parseMotanGraphs,motanGraphDatasets,motanGraphPanels} from '../src/motan/graph.ts';
import {renderMotanGraph} from '../src/motan/graph-render.ts';
import {writePlotDocument} from '../src/diagnostics/graphstats-file.ts';
const directory=await mkdtemp(join(tmpdir(),'motan-graph-bench-')),prefix=join(directory,'capture'),executor=new MotanAnalysisExecutor(),results=[];
const graphs=parseMotanGraphs("[['trapq(toolhead,x)?color=green','derivative(trapq(toolhead,x))?color=tab:blue&ls=--'],['status(heater.temperature)?color=red']]");
try{
 await managerFixture(prefix,2,'cartesian');
 for(const format of ['svg','png']){
  const samples:number[]=[];let bytes=0,points=0;
  for(let i=0;i<16;i++){
   const start=performance.now(),analysis=await executor.analyze({prefix,datasets:motanGraphDatasets(graphs),duration:.5,segmentTime:.0001}),panels=motanGraphPanels(analysis,graphs,'Synthetic capture'),output=join(directory,'plot.'+format);
   await writePlotDocument(panels,()=>renderMotanGraph(panels),output,new AbortController().signal);
   const elapsed=performance.now()-start;if(i>=5)samples.push(elapsed);
   points=panels.reduce((n,p)=>n+p.curves.reduce((n,c)=>n+c.values.length,0),0);assert.equal(points,15003);bytes=(await readFile(output)).length;
   if(format==='png'){const info=await sharp(output).metadata();assert.equal(info.width,800);assert.equal(info.height,1200);}
  }
  samples.sort((a,b)=>a-b);results.push({format,points,bytes,medianMs:samples[5],p95Ms:samples[10]});
 }
 await copyFile(join(directory,'plot.png'),'/tmp/motan-graph-export-review.png');
 console.log(JSON.stringify({node:process.version,warmups:5,runs:11,results,scope:'Synthetic capture file read, fresh analysis worker per job, full three-curve layout, SVG or PNG encoding and atomic write. Decode checks outside timer. No Python renderer comparison, browser frame rate or physical print timing.'},null,2));
}finally{await executor.close();await rm(directory,{recursive:true,force:true});}
