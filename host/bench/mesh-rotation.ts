// GPL-3.0-or-later. Offline rendering cost, excluding browser frame latency.
import assert from 'node:assert/strict';
import {meshSurfacePlot,renderMeshSurfaceSvg} from '../src/diagnostics/mesh-surface.ts';
import {renderInteractivePlot} from '../src/diagnostics/interactive-plot.ts';
const params={min_x:0,max_x:200,min_y:0,max_y:150,x_count:40,y_count:30};
const matrix=(offset:number)=>Array.from({length:30},(_,r)=>Array.from({length:40},(_,c)=>((c-20)**2-(r-15)**2)/10000+offset));
const data={current_mesh:{name:'current',mesh_params:params,probed_matrix:matrix(0)},profiles:{saved:{mesh_params:params,points:matrix(.025)}}};
const plot=meshSurfacePlot(data,'overlay','saved'),results=[];
for(const interactive of [false,true]){
 const samples:number[]=[];let bytes=0;
 for(let i=0;i<16;i++){
  const start=performance.now(),svg=renderMeshSurfaceSvg(plot,interactive),document=interactive?renderInteractivePlot(svg):svg,elapsed=performance.now()-start;
  if(i>=5)samples.push(elapsed);bytes=Buffer.byteLength(document);
  assert.equal((document.match(/<polygon/g)||[]).length,2*29*39);
  assert.equal((document.match(/data-surface-vertices=/g)||[]).length,interactive?2*29*39:0);
 }
 samples.sort((a,b)=>a-b);results.push({format:interactive?'rotatable HTML':'static SVG',bytes,medianMs:samples[5],p95Ms:samples[10]});
}
console.log(JSON.stringify({node:process.version,rows:30,columns:40,surfaces:2,cells:2262,warmups:5,runs:11,results,scope:'Clipping, projection, depth ordering, complete normalized geometry and CSP HTML generation. No browser layout, paint, pointer latency, IO or printer timing.'},null,2));
