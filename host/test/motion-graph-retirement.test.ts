import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {motionReferenceCases} from '../contracts/motion-graph-fixtures.ts';
import {motionGraphReference} from '../bench/motion-graph-reference.ts';
import {motionPlots,motionPositions} from '../src/diagnostics/graph-motion.ts';
test('all captured motion configurations preserve full original positions and ten curves',t=>{
 const maxError=[0,0,0];let positionError=0;
 for(const c of motionReferenceCases){const ref=motionGraphReference(c.filter,c.smoothTime,c.profile),positions=motionPositions(c.profile);assert.equal(positions.length,ref.positions.length);positions.forEach((v,i)=>{positionError=Math.max(positionError,Math.abs(v-ref.positions[i]));assert.ok(Math.abs(v-ref.positions[i])<=1e-12);});const panels=motionPlots(c.filter,c.smoothTime,c.profile);assert.equal(panels.length,ref.panels.length);panels.forEach((p,i)=>{const r=ref.panels[i];assert.equal(p.plot.curves.length,r.curves.length);assert.deepEqual(p.yRanges?.[0],r.range);assert.equal(p.plot.axes[0],r.axis);p.plot.curves.forEach((curve,j)=>{const expected=r.curves[j];assert.deepEqual(curve.times,expected.times);assert.equal(curve.values.length,expected.values.length);curve.values.forEach((v,k)=>{const error=Math.abs(v-expected.values[k]);assert.ok(error<=[1e-8,1e-4,1e-10][i]);maxError[i]=Math.max(maxError[i],error);});});});}
 assert.throws(()=>motionGraphReference('weighted4',.023),/No original Python reference/);t.diagnostic(JSON.stringify({cases:motionReferenceCases.length,positionError,maxError}));
});
test('retired motion CLI exports every documented format without Python and preserves old files on failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motion-retirement-')),cli=fileURLToPath(new URL('../../scripts/graph_motion.ts',import.meta.url)),env={...process.env,PATH:dir,PYTHON:'/nonexistent-python'};
 try{for(const ext of ['json','svg','html','pdf','png','jpg','webp','tiff']){const path=join(dir,'plot.'+ext);execFileSync(process.execPath,[cli,'-o',path],{env});if(ext==='json')assert.deepEqual(JSON.parse(await readFile(path,'utf8')),motionPlots());else if(ext==='svg'||ext==='html'){const text=await readFile(path,'utf8');assert.match(text,/panel2/);assert.match(text,/Spring deviation/);if(ext==='html')assert.match(text,/<script>/);}else if(ext==='pdf'){const text=execFileSync('pdftotext',[path,'-'],{encoding:'utf8'});for(const label of ['Velocity (mm/s)','Acceleration (mm/s^2)','Deviation (mm)','Time (s)'])assert.ok(text.includes(label),label);}else{const meta=await sharp(path).metadata();assert.equal(meta.width,800);assert.equal(meta.height,1800);}}
 const old=join(dir,'old.json');await writeFile(old,'preserve');for(const args of [['--filter','weighted4','--smooth_time','1e999'],['--filter','weighted4','--smooth_time','.00001'],['--legacy_shaper','zv','--filter','smooth'],['--accel_order','3']]){assert.equal(spawnSync(process.execPath,[cli,'-o',old,...args],{env}).status,1);assert.equal(await readFile(old,'utf8'),'preserve');}
 }finally{await rm(dir,{recursive:true,force:true});}
});
