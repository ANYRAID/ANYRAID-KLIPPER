// GPL-3.0-or-later. Vertex expansion only, outside the printer control loop.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {motanStepVertices,type MotanDrawStyle} from '../src/motan/step-plot.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/motan-step-plot.json',import.meta.url),'utf8'));
const x=Array.from({length:100000},(_,i)=>i*.0001),y=Array.from({length:100000},(_,i)=>i%17),results=[];
for(const kind of ['steps-pre','steps-post','steps-mid'] as MotanDrawStyle[]){
 const samples:number[]=[];
 for(let i=0;i<30;i++){
  const start=performance.now(),result=motanStepVertices(x,y,kind),elapsed=performance.now()-start;
  if(i>=5)samples.push(elapsed);
  assert.equal(result.x.length,reference.pythonTimings[kind].points);assert.equal(result.x[0],x[0]);assert.equal(result.x.at(-1),x.at(-1));assert.equal(result.y.at(-1),y.at(-1));
 }
 samples.sort((a,b)=>a-b);results.push({drawstyle:kind,medianMs:samples[12],p95Ms:samples[23],historicalPython:reference.pythonTimings[kind]});
}
console.log(JSON.stringify({node:process.version,inputPoints:x.length,warmups:5,runs:25,results,scope:'Finite validation and complete step-vertex allocation; historical Matplotlib/NumPy expansion has no equivalent admission checks. No rendering, IPC, IO or print-speed claim.'},null,2));
