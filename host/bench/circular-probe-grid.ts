import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {planProbeGrid,measureProbeGrid,type ProbeGrid} from '../src/homing/probe-grid.ts';
const grid:ProbeGrid={circle:{radius:50,origin:[0,0]},mesh:{min_x:-50,max_x:50,min_y:-50,max_y:50,x_count:5,y_count:5,mesh_x_pps:2,mesh_y_pps:2,algo:'lagrange',tension:.2},horizontalHeight:5,travelSpeed:50};
const plan=planProbeGrid(grid,[0,0,0]);let position=[0,0,5,0];
const mesh=await measureProbeGrid(plan,{position:()=>position,move:async p=>{position=[...p];},probe:async()=>position[0]*.001+position[1]*.002},new AbortController().signal);
assert.equal(plan.points.length,13);assert(Math.abs(mesh.calcZ(0,0))<1e-14);
const plans:number[]=[],lookups:number[]=[];let checksum=0;
for(let run=0;run<6;run++){
 let start=performance.now();for(let i=0;i<1000;i++)assert.equal(planProbeGrid(grid,[1,2,0]).points.length,13);const planning=performance.now()-start;
 start=performance.now();for(let i=0;i<1000000;i++)checksum+=mesh.calcZ((i%101)-50,(i%97)-48);const lookup=performance.now()-start;
 if(run){plans.push(planning);lookups.push(lookup);}
}
const median=(v:number[])=>[...v].sort((a,b)=>a-b)[2],result={node:process.version,planning1000Ms:plans,lookupMillionMs:lookups,medianPlanningMs:median(plans),medianLookupMs:median(lookups),checksum,passed:median(plans)<1000&&median(lookups)<1000,scope:'Circular grid planning and existing interpolated lookup on synthetic heights; excludes probe IO, concurrent print load and physical accuracy.'};
assert(Number.isFinite(checksum));assert(result.passed);await writeFile(new URL('../contracts/circular-probe-grid.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(result);
