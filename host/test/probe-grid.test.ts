import test from 'node:test';
import assert from 'node:assert/strict';
import {planProbeGrid,measureProbeGrid} from '../src/homing/probe-grid.ts';
const options={mesh:{min_x:10,max_x:20,min_y:30,max_y:40,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct' as const,tension:.2},horizontalHeight:5,travelSpeed:50};
test('serpentine grid applies probe XY offsets and preserves matrix orientation',async()=>{
 const plan=planProbeGrid(options,[2,-3,1]),moves:number[][]=[];let position=[0,0,7,9],sample=0;
 const mesh=await measureProbeGrid(plan,{position:()=>position,move:async target=>{moves.push([...target]);position=[...target];},probe:async()=>{position[2]=1;return [1,2,4,3][sample++];}},new AbortController().signal);
 assert.deepEqual(plan.points.map(p=>[p.nozzleX,p.nozzleY]),[[8,33],[18,33],[18,43],[8,43]]);
 assert.deepEqual([...mesh.probedValues()],[1,2,3,4]);assert.deepEqual(moves[0],[0,0,7,9]);assert.deepEqual(moves[1],[8,33,7,9]);assert.deepEqual(position,[8,43,5,9]);
});
test('cancelled or invalid sample does not publish a partial mesh',async()=>{
 const plan=planProbeGrid(options,[0,0,0]),c=new AbortController();let position=[0,0,5,0];
 await assert.rejects(measureProbeGrid(plan,{position:()=>position,move:async p=>{position=[...p];},probe:async()=>{c.abort(Error('cancel grid'));return 0;}},c.signal),/cancel grid/);
 await assert.rejects(measureProbeGrid(plan,{position:()=>position,move:async()=>{},probe:async()=>NaN},new AbortController().signal),/Invalid/);
 assert.throws(()=>planProbeGrid({...options,mesh:{...options.mesh,x_count:1e9}},[0,0,0]),/probe count/);
});
for(const external of [false,true])test(`zero reference ${external?'outside':'inside'} mesh preserves exact heights and travel`,async()=>{
 const reference:[number,number]=external?[25,35]:[15,35],plan=planProbeGrid({...options,zeroReference:reference},[2,-3,0]);let position=[0,0,5,0],count=0;
 const mesh=await measureProbeGrid(plan,{position:()=>position,move:async p=>{position=[...p];},probe:async()=>{count++;return position[0]+2+(position[1]-3)*2;}},new AbortController().signal);
 assert.equal(count,external?5:4);const offset=reference[0]+reference[1]*2;
 assert.deepEqual([...mesh.probedValues()],[70-offset,80-offset,90-offset,100-offset]);if(!external)assert.equal(mesh.calcZ(...reference),0);
 assert.equal(position[2],5);if(external)assert.deepEqual(position.slice(0,2),[23,38]);
});
test('circular grid probes only disk points and pads edges without transposing snake rows',async()=>{
 const plan=planProbeGrid({...options,circle:{radius:20,origin:[12,-7]},mesh:{...options.mesh,x_count:5,y_count:5}},[2,-3,0]);
 assert.equal(plan.points.length,13);
 assert.deepEqual(plan.points.map(p=>[p.x,p.y]),[[2,0],[3,1],[2,1],[1,1],[0,2],[1,2],[2,2],[3,2],[4,2],[3,3],[2,3],[1,3],[2,4]]);
 let position=[0,0,5,17];const mesh=await measureProbeGrid(plan,{position:()=>position,move:async p=>{position=[...p];},probe:async()=>{const x=position[0]+2,y=position[1]-3;assert(Math.hypot(x-12,y+7)<=20);return x+2*y;}},new AbortController().signal);
 assert.deepEqual([...mesh.probedValues()],[-42,-42,-42,-42,-42,-32,-32,-22,-12,-12,-22,-12,-2,8,18,8,8,18,28,28,38,38,38,38,38]);
 assert.equal(mesh.calcZ(12,-7),-2);assert.equal(position[3],17);
});
test('circular spacing truncates hundredths and rejects even counts',()=>{
 const grid={...options,circle:{radius:50,origin:[0,0] as const},mesh:{...options.mesh,x_count:7,y_count:7}};
 const plan=planProbeGrid(grid,[0,0,0]);assert.equal(plan.mesh.max_x,49.98);assert.equal(plan.mesh.min_y,-49.98);
 assert(plan.points.every(p=>Math.hypot(p.nozzleX,p.nozzleY)<=50));
 assert.throws(()=>planProbeGrid({...grid,mesh:{...grid.mesh,x_count:4,y_count:4}},[0,0,0]),/circular/);
});
for(const external of [false,true])test(`circular zero reference is applied after edge padding; external=${external}`,async()=>{
 const reference:[number,number]=external?[30,0]:[0,0],plan=planProbeGrid({...options,zeroReference:reference,circle:{radius:20,origin:[0,0]},mesh:{...options.mesh,x_count:5,y_count:5}},[2,3,0]);let position=[0,0,5,0],samples=0;
 const mesh=await measureProbeGrid(plan,{position:()=>position,move:async p=>{position=[...p];},probe:async()=>{samples++;return position[0]+2+2*(position[1]+3);}},new AbortController().signal);
 assert.equal(samples,external?14:13);assert.equal(mesh.calcZ(0,0),external?-30:0);assert.equal(mesh.calcZ(-20,-20),external?-70:-40);
});
test('hundredth grid preserves circular boundary rows at floating point multiplication edges',()=>{
 for(const radius of [3.9,4.8,6.3,7.8,50.1,99.9]){
  const plan=planProbeGrid({...options,circle:{radius,origin:[12,-7]},mesh:{...options.mesh,x_count:7,y_count:7}},[0,0,0]);
  for(let y=0;y<7;y++){const row=plan.points.filter(p=>p.y===y);assert(row.length>0,`missing row ${y} at radius ${radius}`);assert.equal(row.length%2,1);assert.equal(row[0].x+row.at(-1)!.x,6);}
  assert(plan.points.some(p=>p.x===3&&p.y===0));assert(plan.points.some(p=>p.x===3&&p.y===6));
 }
});
test('circular grids retain every row across tenth-millimeter radii and odd counts',()=>{
 let grids=0;
 for(let tenth=10;tenth<=3000;tenth++)for(let n=3;n<=31;n+=2){
  const radius=tenth/10;if(Math.floor(2*radius/(n-1)*100)<100)continue;
  const plan=planProbeGrid({...options,circle:{radius,origin:[0,0]},mesh:{...options.mesh,x_count:n,y_count:n}},[0,0,0]);
  assert.equal(new Set(plan.points.map(p=>p.y)).size,n,`radius=${radius}, count=${n}`);grids++;
 }
 assert.equal(grids,43815);
});
