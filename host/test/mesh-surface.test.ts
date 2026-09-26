import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {meshSurfacePlot,renderMeshSurfaceSvg} from '../src/diagnostics/mesh-surface.ts';
const params={min_x:0,max_x:100,min_y:10,max_y:210,x_count:2,y_count:2},fixture=()=>({axis_minimum:[10,20,0],axis_maximum:[90,200,300],current_mesh:{name:'active<&',mesh_params:{...params},probed_matrix:[[1,2],[3,4]],mesh_matrix:[[1,1.5,2],[2,2.5,3],[3,3.5,4]]},profiles:{saved:{mesh_params:{...params},points:[[.5,1.5],[2.5,3.5]]}}});
test('surface selection, rectangular coordinates and delta respect parameter tolerance without broadcasting',()=>{const data=fixture();assert.deepEqual(meshSurfacePlot(data,'probedz').surfaces[0].y,[10,210]);assert.deepEqual(meshSurfacePlot(data,'probedz','saved').surfaces[0].z,[.5,1.5,2.5,3.5]);assert.equal(meshSurfacePlot(data,'meshz').surfaces[0].z.length,9);assert.equal(meshSurfacePlot(data,'overlay','saved').surfaces.length,2);assert.deepEqual(meshSurfacePlot(data,'delta','saved').surfaces[0].z,[.5,.5,.5,.5]);data.profiles.saved.mesh_params.max_y+=.0000005;assert.doesNotThrow(()=>meshSurfacePlot(data,'delta','saved'));data.profiles.saved.mesh_params.max_y+=.000002;assert.throws(()=>meshSurfacePlot(data,'delta','saved'),/mismatch/);assert.throws(()=>meshSurfacePlot(data,'overlay'),/required/);assert.throws(()=>meshSurfacePlot(data,'probedz','missing'),/not found/);data.profiles.saved.mesh_params={...params};data.profiles.saved.points=[[1,2,3],[4,5,6]];assert.throws(()=>meshSurfacePlot(data,'delta','saved'),/dimensions/);});
test('surface rendering escapes names, clips machine bounds and supports flat zero height',()=>{const plot=meshSurfacePlot(fixture(),'probedz',undefined,true),svg=renderMeshSurfaceSvg(plot);assert.match(svg,/active&lt;&amp;/);assert.equal((svg.match(/<polygon/g)||[]).length,1);assert.ok(!/NaN|Infinity/.test(svg));assert.match(svg,/X 10..90 mm/);const zero=fixture();zero.current_mesh.probed_matrix=[[0,0],[0,0]];assert.equal(meshSurfacePlot(zero,'probedz').bounds.z[1],.001);assert.doesNotThrow(()=>renderMeshSurfaceSvg(meshSurfacePlot(zero,'probedz')));const large={...plot,surfaces:[{name:'large',x:Array.from({length:225},(_,i)=>i),y:Array.from({length:225},(_,i)=>i),z:Array(225*225).fill(0)}]};assert.throws(()=>renderMeshSurfaceSvg(large),/50000/);const outside={...plot,bounds:{...plot.bounds,x:[1000,1100] as [number,number]}};assert.equal((renderMeshSurfaceSvg(outside).match(/<polygon/g)||[]).length,0);});
test('surface CLI exports PNG and full model JSON and protects files on incompatible delta',async()=>{const dir=await mkdtemp(join(tmpdir(),'mesh-surface-')),input=join(dir,'mesh.json'),out=join(dir,'mesh.png'),json=join(dir,'delta.json'),cli=fileURLToPath(new URL('../../scripts/graph_mesh.ts',import.meta.url));try{await writeFile(input,JSON.stringify(fixture()));execFileSync(process.execPath,[cli,'plot','overlay','-p','saved','-o',out,input]);assert.equal((await sharp(out).metadata()).width,1000);execFileSync(process.execPath,[cli,'plot','delta','-p','saved','-o',json,input]);assert.deepEqual(JSON.parse(await readFile(json,'utf8')),meshSurfacePlot(fixture(),'delta','saved'));const bytes=await readFile(out),bad=fixture();bad.profiles.saved.mesh_params.x_count=3;await writeFile(input,JSON.stringify(bad));assert.equal(spawnSync(process.execPath,[cli,'plot','delta','-p','saved','-o',out,input]).status,1);assert.deepEqual(await readFile(out),bytes);}finally{await rm(dir,{recursive:true,force:true});}});

test('interactive surface embeds clipped full-precision geometry only in HTML export',async()=>{
 const plot=meshSurfacePlot(fixture(),'overlay','saved',true),staticSvg=renderMeshSurfaceSvg(plot),svg=renderMeshSurfaceSvg(plot,true);
 assert.doesNotMatch(staticSvg,/data-surface/);assert.equal((svg.match(/data-surface-vertices=/g)||[]).length,2);
 assert.equal((svg.match(/data-surface-axis=/g)||[]).length,3);assert.equal((svg.match(/data-surface-label=/g)||[]).length,3);
 for(const match of svg.matchAll(/data-surface-vertices="([^"]+)"/g)){
  const values=match[1].split(' ').map(Number);assert.ok(values.every(Number.isFinite));
  for(let i=0;i<values.length;i+=3){assert.ok(Math.abs(values[i])<=.5);assert.ok(Math.abs(values[i+1])<=.5);assert.ok(Math.abs(values[i+2])<=1/3);}
 }
 assert.match(svg,/active&lt;&amp;/);assert.ok(!svg.includes('active<&'));
 const dir=await mkdtemp(join(tmpdir(),'mesh-rotation-')),input=join(dir,'mesh.json'),output=join(dir,'mesh.html'),cli=fileURLToPath(new URL('../../scripts/graph_mesh.ts',import.meta.url));
 try{
  await writeFile(input,JSON.stringify(fixture()));
  for(const type of ['probedz','meshz','overlay','delta']){
   execFileSync(process.execPath,[cli,'plot',type,...(['overlay','delta'].includes(type)?['-p','saved']:[]),'-o',output,input]);
   const html=await readFile(output,'utf8');assert.match(html,/data-surface-faces="true"/);assert.match(html,/Reset 3D view/);assert.match(html,/script-src 'sha256-/);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('default static SVG remains byte-identical to the pre-rotation renderer for all four surface modes',async()=>{
 const {createHash}=await import('node:crypto');
 const {staticComparison}=JSON.parse(await readFile(new URL('../contracts/mesh-rotation.json',import.meta.url),'utf8'));
 for(const row of staticComparison.staticOutputs){
  const model=meshSurfacePlot(staticComparison.fixture,row.type,['overlay','delta'].includes(row.type)?'saved':undefined),svg=renderMeshSurfaceSvg(model);
  assert.equal(Buffer.byteLength(svg),row.bytes);assert.equal(createHash('sha256').update(svg).digest('hex'),row.sha256,row.type);
 }
});
