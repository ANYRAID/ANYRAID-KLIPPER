import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {extruderPositions,extruderPlot,rawPressureAdvance,weightedExtruder} from '../src/diagnostics/graph-extruder.ts';
import {extruderReference} from '../bench/extruder-reference.ts';
import {renderStatsSvg} from '../src/diagnostics/stats-svg.ts';
export function compare(actual:readonly number[],expected:readonly number[],limit:number){assert.equal(actual.length,expected.length);let max=0;for(let i=0;i<actual.length;i++){assert.ok(Number.isFinite(actual[i]));max=Math.max(max,Math.abs(actual[i]-expected[i]));}assert.ok(max<=limit,`maximum absolute error ${max} > ${limit}`);return max;}
test('extruder diagnostic matches original positions, raw PA, smoothed positions and all velocity curves',()=>{
 const expected=extruderReference(),positions=extruderPositions(),raw=rawPressureAdvance(positions),smooth=weightedExtruder(raw),plot=extruderPlot();compare(positions,expected.positions,1e-14);compare(raw,expected.raw,1e-12);compare(smooth,expected.smooth,1e-12);assert.equal(plot.title,expected.plot.title);assert.deepEqual(plot.axes,expected.plot.axes);assert.equal(plot.curves.length,expected.plot.curves.length);plot.curves.forEach((c,i)=>{const e=expected.plot.curves[i];assert.equal(c.label,e.label);assert.deepEqual(c.times,e.times);compare(c.values,e.values,2e-8);});assert.ok(Math.min(...plot.curves[2].values)<0);assert.throws(()=>weightedExtruder(raw,0),RangeError);assert.throws(()=>weightedExtruder(raw,.101),RangeError);
});
test('extruder numeric time axis retains subsecond ticks and escapes axis label',()=>{const svg=renderStatsSvg(extruderPlot(),{label:'Time <s>',format:'number'});assert.match(svg,/Time &lt;s&gt;/);assert.doesNotMatch(svg,/Time \(UTC\)|00:00:00/);assert.match(svg,/>0\.\d+<\/text>/);});
test('extruder CLI exports usable JSON, SVG and PNG and rejects missing output or operands',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'extruder-cli-')),cli=fileURLToPath(new URL('../../scripts/graph_extruder.ts',import.meta.url));try{for(const ext of ['json','svg','png']){const path=join(dir,'plot.'+ext);execFileSync(process.execPath,[cli,'-o',path]);if(ext==='json')assert.deepEqual(JSON.parse(await readFile(path,'utf8')),extruderPlot());else if(ext==='svg')assert.match(await readFile(path,'utf8'),/Time \(s\)/);else{const meta=await sharp(path).metadata();assert.equal(meta.width,800);assert.equal(meta.height,600);}}for(const args of [[],['unwanted','-o',join(dir,'bad.svg')]])assert.equal(spawnSync(process.execPath,[cli,...args]).status,1);assert.match(execFileSync(process.execPath,[cli,'--help'],{encoding:'utf8'}),/Usage:/);}finally{await rm(dir,{recursive:true,force:true});}
});
