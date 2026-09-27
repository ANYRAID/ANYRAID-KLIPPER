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
