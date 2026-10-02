import {performance} from 'node:perf_hooks';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {adaptProbeGrid} from '../src/homing/adaptive-probe-grid.ts';
import {planProbeGrid,type ProbeGrid} from '../src/homing/probe-grid.ts';
const grid:ProbeGrid={mesh:{min_x:0,max_x:100,min_y:0,max_y:100,x_count:9,y_count:9,mesh_x_pps:2,mesh_y_pps:2,algo:'bicubic',tension:.2},horizontalHeight:5,travelSpeed:50},polygons=[[[20,30],[40,30],[40,50],[20,50]]],samples:number[]=[];
for(let run=0;run<6;run++){const start=performance.now();for(let i=0;i<1000;i++){const result=adaptProbeGrid(grid,polygons,5);assert(result.adapted);assert.equal(result.grid.mesh.x_count,3);}if(run)samples.push(performance.now()-start);}
const median=[...samples].sort((a,b)=>a-b)[2],evidence={node:process.version,adaptations1000Ms:samples,medianMs:median,originalContacts:planProbeGrid(grid,[0,0,0]).points.length,adaptedContacts:planProbeGrid(adaptProbeGrid(grid,polygons,5).grid,[0,0,0]).points.length,passed:median<1000,scope:'Pure adaptive footprint calculation; not yet connected to immutable print-file object extraction or product calibration. No physical timing or precision claim.'};assert(evidence.passed);await writeFile(new URL('../contracts/adaptive-probe-grid.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');console.log(evidence);
