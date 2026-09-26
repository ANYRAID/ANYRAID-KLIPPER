import test from 'node:test';
import assert from 'node:assert/strict';
import {capturedMeshInput,meshReference} from '../bench/mesh-reference.ts';
import {meshGrid,meshStatistics,duplicateMeshPoints} from '../src/diagnostics/mesh-analysis.ts';
import {meshPathPlot,type MeshPathType} from '../src/diagnostics/mesh-path.ts';
import {meshSurfacePlot,type MeshSurfaceType} from '../src/diagnostics/mesh-surface.ts';
import {analyzeMeshDump} from '../src/diagnostics/mesh-report.ts';
function compare(actual:any,expected:any,tolerance:number){
 for(const key of Object.keys(expected)){
  if(typeof expected[key]==='number')assert.ok(Math.abs(actual[key]-expected[key])<=tolerance,`${key}: ${actual[key]} versus ${expected[key]}`);
  else if(typeof expected[key]==='object')compare(actual[key],expected[key],tolerance);
  else assert.equal(actual[key],expected[key]);
 }
}
test('large rectangular mesh statistics and duplicate path points match captured NumPy',()=>{
 const input=capturedMeshInput('analysis') as any,ref=meshReference('analysis',input);
 const actual=meshStatistics(meshGrid(input.matrix,input.params));
 const {duplicates,minimum,maximum,...statistics}=ref.result;compare(actual,statistics,1e-14);compare(actual.minimum,minimum,1e-12);compare(actual.maximum,maximum,1e-12);assert.deepEqual(duplicateMeshPoints(input.path),duplicates);
});
test('all captured probe paths retain exact complete coordinates',()=>{
 const input=capturedMeshInput('path'),ref=meshReference('path',input);
 for(const kind of ['points','path','rapid'] as MeshPathType[]){
  const p=meshPathPlot(input,kind),groups=kind==='points'?[p.sampled]:[p.travel,p.sampled,[p.travel[0]],[p.travel.at(-1)!],p.missing];
  assert.equal(groups.length,ref[kind].curves.length);
  groups.forEach((points,i)=>{assert.deepEqual(points.map(p=>p[0]),ref[kind].curves[i].x);assert.deepEqual(points.map(p=>p[1]),ref[kind].curves[i].y);});
 }
});
test('all four original surface arrays match without downsampling',()=>{
 const input=capturedMeshInput('surface'),ref=meshReference('surface',input);
 for(const kind of ['probedz','meshz','overlay','delta'] as MeshSurfaceType[]){
  const plot=meshSurfacePlot(input,kind,['overlay','delta'].includes(kind)?'saved':undefined);
  assert.equal(plot.surfaces.length,ref[kind].surfaces.length);
  plot.surfaces.forEach((surface,i)=>{const expected=ref[kind].surfaces[i];assert.deepEqual(surface.z,expected.z.flat());surface.y.forEach((y,r)=>{assert.deepEqual(surface.x,expected.x[r]);assert.deepEqual(Array(surface.x.length).fill(y),expected.y[r]);});});
 }
});
test('multi-profile report agrees with original Python including comparison direction',()=>{
 const input=capturedMeshInput('report'),ref=meshReference('report',input),actual=analyzeMeshDump(input);
 assert.equal(actual.meshes.length,ref.meshes.length);assert.equal(actual.comparisons.length,ref.comparisons.length);
 actual.meshes.forEach((mesh,i)=>{assert.equal(mesh.name,ref.meshes[i].name);compare(mesh.statistics,ref.meshes[i].statistics,1e-12);});
 actual.comparisons.forEach((item,i)=>{assert.equal(item.from,ref.comparisons[i].fromName);assert.equal(item.to,ref.comparisons[i].to);compare(item.statistics,ref.comparisons[i].statistics,1e-12);});
});
test('captured socket payload is exact and modified inputs cannot select an oracle',()=>{
 const input=capturedMeshInput('source'),ref=meshReference('source',input);assert.deepEqual(ref.result,input);
 assert.throws(()=>meshReference('source',{}),/input changed/);
 ref.result.profiles.injected={};assert.deepEqual(meshReference('source',input).result,input);
});
