import assert from 'node:assert/strict';
import {planProbeGrid,measureProbeGrid} from '../src/homing/probe-grid.ts';
const signal=new AbortController().signal,times:number[]=[];
for(let i=0;i<1100;i++){
 const start=performance.now(),plan=planProbeGrid({mesh:{min_x:0,max_x:200,min_y:0,max_y:200,x_count:6,y_count:6,mesh_x_pps:2,mesh_y_pps:2,algo:'bicubic',tension:.2},horizontalHeight:5,travelSpeed:50},[-20,3,1]);let position=[0,0,5,0];
 const mesh=await measureProbeGrid(plan,{position:()=>position,move:async p=>{position=[...p];},probe:async()=>.125},signal);assert.equal(mesh.probedValues().length,36);assert.equal(mesh.calcZ(100,100),.125);if(i>=100)times.push(performance.now()-start);
}
times.sort((a,b)=>a-b);assert(times[949]<10,'Grid orchestration exceeded 10 ms P95');console.log(JSON.stringify({node:process.version,samples:1000,points:36,medianMs:times[499],p95Ms:times[949],scope:'Path planning, async orchestration and interpolation with fake constant measurement; excludes native movement and transport.'}));
