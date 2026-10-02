// GPL-3.0-or-later. Plot planning only; excludes capture analysis and rendering.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseMotanGraphs,motanGraphPanels} from '../src/motan/graph.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/motan-graph-layout.json',import.meta.url),'utf8'));
const count=100000,times=Float64Array.from({length:count},(_,i)=>i/100),datasets=Object.fromEntries([...'abcd'].map((name,index)=>[name,Float64Array.from({length:count},(_,i)=>i/4+index)])),labels=reference.cases[0].labels;
const graphs=parseMotanGraphs("[['a','b'],['c','d']]"),samples:number[]=[];
for(let i=0;i<16;i++){
 const start=performance.now(),panels=motanGraphPanels({times,datasets,labels},graphs,'fixture'),elapsed=performance.now()-start;
 if(i>=5)samples.push(elapsed);
 assert.equal(panels.length,2);assert.equal(panels[1].curves[1].values.length,count);assert.equal(panels[1].curves[1].values.at(-1),(count-1)/4+3);assert.deepEqual(panels.map(p=>p.axes),[['Position\n(mm)','Velocity\n(mm/s)'],['Temperature','Velocity\n(mm/s)']]);
}
samples.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,samples:count,curves:4,medianMs:samples[5],p95Ms:samples[10],historicalPython:reference.pythonBenchmark,scope:'Unit assignment, admission validation and full independent numeric curve snapshots. No input loading, worker analysis, plotting/rendering or printer timing.'},null,2));
