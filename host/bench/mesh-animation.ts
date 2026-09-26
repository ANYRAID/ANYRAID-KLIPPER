// GPL-3.0-or-later. Diagnostic animation preparation; never physical motion timing.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {meshPathAnimationFrames,meshPathPlot,renderMeshPathSvg} from '../src/diagnostics/mesh-path.ts';
import {renderInteractivePlot} from '../src/diagnostics/interactive-plot.ts';
import type {MeshPoint} from '../src/diagnostics/mesh-analysis.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/mesh-animation.json',import.meta.url),'utf8'));
const points:MeshPoint[]=Array.from({length:100000},(_,i)=>[i%1000,Math.floor(i/1000)]),times:number[]=[];
for(let i=0;i<30;i++){
 const start=performance.now(),frames=meshPathAnimationFrames(points),elapsed=performance.now()-start;
 assert.equal(frames.length,reference.benchmark.frames);assert.equal(frames[0],1);assert.equal(frames.at(-1),100000);
 if(i>=5)times.push(elapsed);
}
const small:MeshPoint[]=Array.from({length:1000},(_,i)=>[Math.floor(i/25)%2?24-i%25:i%25,Math.floor(i/25)]);
const model=meshPathPlot({calibration:{points:small,probe_path:small}},'path'),exports:number[]=[];let html='';
for(let i=0;i<30;i++){
 const start=performance.now();html=renderInteractivePlot(renderMeshPathSvg(model,true));const elapsed=performance.now()-start;
 assert.ok(html.includes('data-mesh-animation="'));if(i>=5)exports.push(elapsed);
}
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[12],p95Ms:values[23]};};
writeFileSync('/tmp/mesh-animation-review.html',html);
console.log(JSON.stringify({node:process.version,points:points.length,framePreparation:stats(times),historicalPython:reference.benchmark,htmlPoints:small.length,htmlGeneration:stats(exports),htmlBytes:Buffer.byteLength(html),scope:'Offline frame preparation and interactive HTML generation; no browser paint, real-time timer or printer-speed claim.'},null,2));
