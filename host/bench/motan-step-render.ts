// GPL-3.0-or-later. Full SVG step rendering, no decimation.
import assert from 'node:assert/strict';
import {parseMotanGraphs,motanGraphPanels} from '../src/motan/graph.ts';
import {renderMotanGraph} from '../src/motan/graph-render.ts';
const points=10000,input={times:Float64Array.from({length:points},(_,i)=>i*.001),datasets:{a:Float64Array.from({length:points},(_,i)=>i%17)},labels:{a:{name:'a',label:'Sampled signal',units:'mm'}}},results=[];
for(const kind of ['default','steps-pre','steps-post','steps-mid']){
 const panels=motanGraphPanels(input,parseMotanGraphs(`[['a?drawstyle=${kind}']]`),'fixture'),samples:number[]=[];let bytes=0;
 for(let i=0;i<16;i++){
  const start=performance.now(),svg=renderMotanGraph(panels),elapsed=performance.now()-start;if(i>=5)samples.push(elapsed);bytes=Buffer.byteLength(svg);
  const curve=/<g data-curve-label="Sampled signal"[^>]*>([\s\S]*?)<\/g>/.exec(svg)![1];
  const path=/<path d="([^"]+)"/.exec(curve)![1];assert.equal((path.match(/[ML]/g)||[]).length,kind==='default'?points:kind==='steps-mid'?2*points:2*points-1);
 }
 samples.sort((a,b)=>a-b);results.push({drawstyle:kind,bytes,medianMs:samples[5],p95Ms:samples[10]});
}
console.log(JSON.stringify({node:process.version,inputPoints:points,warmups:5,runs:11,results,scope:'Complete numeric-axis SVG projection, step expansion, style and legend generation. Model preparation, IO, Python rendering and printer timing excluded.'},null,2));
