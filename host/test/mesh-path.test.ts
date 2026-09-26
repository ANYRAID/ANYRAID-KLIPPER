import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {meshPathPlot,renderMeshPathSvg} from '../src/diagnostics/mesh-path.ts';
const fixture=()=>({axis_minimum:[0,0,0],axis_maximum:[100,200,300],calibration:{points:[[10,10],[20,20],[30,30]],probe_path:[[10,10],[20,20],[10,10]],rapid_path:[[[10,10],true],[[20,20],false],[[30,30],true]]}});
test('path model preserves sample selection, missing points and machine bounds',()=>{const data=fixture(),path=meshPathPlot(data,'path',true);assert.deepEqual(path.sampled,[[20,20]]);assert.deepEqual(path.missing,[[30,30]]);assert.deepEqual(path.bounds,{x:[0,100],y:[0,200]});const rapid=meshPathPlot(data,'rapid');assert.deepEqual(rapid.sampled,[[10,10],[30,30]]);assert.deepEqual(rapid.missing,[[20,20]]);(data.calibration.probe_path[0])[0]=90;assert.equal(path.travel[0][0],10);const svg=renderMeshPathSvg(path);assert.match(svg,/width="280" height="560"/);assert.match(svg,/Start: green triangle/);assert.ok(!/NaN|Infinity/.test(svg));assert.throws(()=>meshPathPlot({...data,axis_maximum:[0,0]},'path',true));assert.throws(()=>meshPathPlot({calibration:{points:[[NaN,1]]}},'points'));assert.doesNotThrow(()=>renderMeshPathSvg(meshPathPlot({calibration:{points:[]}},'points')));});
test('mesh plot CLI produces PNG and full model JSON and refuses unsupported plots',async()=>{const dir=await mkdtemp(join(tmpdir(),'mesh-path-')),input=join(dir,'input.json'),png=join(dir,'path.png'),json=join(dir,'path.json'),cli=fileURLToPath(new URL('../../scripts/graph_mesh.ts',import.meta.url));try{await writeFile(input,JSON.stringify(fixture()));execFileSync(process.execPath,[cli,'plot','rapid','-s','-o',png,input]);const meta=await sharp(png).metadata();assert.equal(meta.width,1000);assert.equal(meta.height,760);execFileSync(process.execPath,[cli,'plot','rapid','-s','-o',json,input]);assert.deepEqual(JSON.parse(await readFile(json,'utf8')),meshPathPlot(fixture(),'rapid',true));const before=await readFile(png);assert.equal(spawnSync(process.execPath,[cli,'plot','unsupported','-o',png,input]).status,1);assert.deepEqual(await readFile(png),before);assert.equal(spawnSync(process.execPath,[cli,'plot','points','-o',input,input]).status,1);assert.match(execFileSync(process.execPath,[cli,'list'],{encoding:'utf8'}),/rapid/);}finally{await rm(dir,{recursive:true,force:true});}});

test('animation reveals axis-aligned frames and includes a final diagonal endpoint',async()=>{
 const {meshPathAnimationFrames}=await import('../src/diagnostics/mesh-path.ts');
 assert.deepEqual(meshPathAnimationFrames([]),[]);
 assert.deepEqual(meshPathAnimationFrames([[0,0]]),[1]);
 assert.deepEqual(meshPathAnimationFrames([[0,0],[1,0],[2,1],[2,2],[3,3]]),[1,2,4,5]);
 assert.throws(()=>meshPathAnimationFrames([[NaN,0]]));
 const model=meshPathPlot(fixture(),'rapid');
 assert.match(renderMeshPathSvg(model,true),/data-mesh-animation="1,3"/);
 assert.doesNotMatch(renderMeshPathSvg(model),/data-mesh-animation/);
 assert.throws(()=>renderMeshPathSvg(meshPathPlot(fixture(),'points'),true),/requires/);
 const dir=await mkdtemp(join(tmpdir(),'mesh-animation-')),input=join(dir,'input.json'),output=join(dir,'animation.html'),cli=fileURLToPath(new URL('../../scripts/graph_mesh.ts',import.meta.url));
 try{
  await writeFile(input,JSON.stringify(fixture()));
  execFileSync(process.execPath,[cli,'plot','rapid','-a','-o',output,input]);
  const html=await readFile(output,'utf8');assert.match(html,/data-mesh-animation="1,3"/);assert.match(html,/Diagnostic playback/);
  for(const args of [['plot','points','-o',output],['plot','path','-o',join(dir,'a.png')],['analyze','-o',output]]){
   const result=spawnSync(process.execPath,[cli,...args,'-a',input],{encoding:'utf8'});assert.equal(result.status,1);assert.match(result.stderr,/Animation requires/);
   assert.equal(await readFile(output,'utf8'),html);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('animation frame rules match captured original Python sequences except explicit final endpoint fix',async()=>{
 const {meshPathAnimationFrames}=await import('../src/diagnostics/mesh-path.ts');
 const reference=JSON.parse(await readFile(new URL('../contracts/mesh-animation.json',import.meta.url),'utf8')) as {cases:{points:[number,number][];legacyFrames:number[]}[]};
 assert.equal(reference.cases.length,6);
 for(const row of reference.cases){const expected=[...row.legacyFrames];if(expected.at(-1)!==row.points.length)expected.push(row.points.length);assert.deepEqual(meshPathAnimationFrames(row.points),expected);}
});
