import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptProbeGrid} from '../src/homing/adaptive-probe-grid.ts';
import {planProbeGrid,type ProbeGrid} from '../src/homing/probe-grid.ts';
const grid:ProbeGrid={mesh:{min_x:0,max_x:100,min_y:0,max_y:100,x_count:9,y_count:9,mesh_x_pps:2,mesh_y_pps:2,algo:'bicubic',tension:.2},horizontalHeight:5,travelSpeed:50};
test('adaptive mesh reduces contact count with margin while retaining original configuration',()=>{
 const before=structuredClone(grid),result=adaptProbeGrid(grid,[[[20,30],[40,30],[40,50],[20,50]]],5);
 assert(result.adapted);assert.deepEqual([result.grid.mesh.min_x,result.grid.mesh.max_x,result.grid.mesh.min_y,result.grid.mesh.max_y],[15,45,25,55]);assert.equal(result.grid.mesh.x_count,3);assert.equal(result.grid.mesh.y_count,3);assert.equal(planProbeGrid(result.grid,[0,0,0]).points.length,9);assert.deepEqual(grid,before);
});
test('narrow footprint keeps bicubic-compatible counts and nonzero physical span',()=>{
 const r=adaptProbeGrid(grid,[[[0,40],[100,40],[100,40.01],[0,40.01]]]);assert.equal(r.grid.mesh.x_count,9);assert.equal(r.grid.mesh.y_count,4);assert.equal(r.grid.mesh.max_y-r.grid.mesh.min_y,3);
});
test('translated circular adaptation encloses object and stays inside original disk',()=>{
 const circle={...grid,circle:{radius:50,origin:[100,100] as const}};
 const result=adaptProbeGrid(circle,[[[99,99],[101,99],[101,101],[99,101]]],1);assert(result.adapted);const c=result.grid.circle!;assert.deepEqual(c.origin,[100,100]);assert(c.radius>=Math.sqrt(8));assert.equal(result.grid.mesh.x_count%2,1);const plan=planProbeGrid(result.grid,[0,0,0]);assert(plan.points.every(p=>Math.hypot(p.nozzleX-100,p.nozzleY-100)<=50));assert(plan.mesh.min_x<=98&&plan.mesh.max_x>=102);
});
test('empty or outside footprint preserves full mesh and invalid inputs reject',()=>{
 assert.equal(adaptProbeGrid(grid,[]).adapted,false);assert.equal(adaptProbeGrid(grid,[[[-1,0],[1,0],[1,1]]]).adapted,false);
 for(const polygons of [[[[0,0]]],[[[0,0],[NaN,0],[1,1]]]])assert.throws(()=>adaptProbeGrid(grid,polygons));assert.throws(()=>adaptProbeGrid(grid,[],-1));
 const small=adaptProbeGrid(grid,[[[50,50],[50,50],[50,50]]]);assert.equal(small.grid.mesh.max_x-small.grid.mesh.min_x,2);
});
test('adaptive circular quantization retains footprint coverage across translated small objects',()=>{
 const circle={...grid,circle:{radius:50,origin:[100,100] as const}};let adapted=0;
 for(let i=1;i<=500;i++){
  const x=80+(i%40),y=80+(i*7%40),width=.01+(i%29)/10,height=.01+(i%31)/10;
  const result=adaptProbeGrid(circle,[[[x,y],[x+width,y],[x+width,y+height],[x,y+height]]],.13);
  if(!result.adapted)continue;adapted++;const p=result.grid.mesh,c=result.grid.circle!;
  assert(p.min_x<=x-.13&&p.max_x>=x+width+.13);assert(p.min_y<=y-.13&&p.max_y>=y+height+.13);
  assert(c.radius+Math.hypot(c.origin[0]-100,c.origin[1]-100)<50);
 }
 assert.equal(adapted,500);
});
