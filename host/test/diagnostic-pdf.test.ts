import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {writeStatsPanels,writePlotDocument} from '../src/diagnostics/graphstats-file.ts';
import {temperaturePlots} from '../src/diagnostics/graph-temperature.ts';
import {writeSpectrogram} from '../src/diagnostics/spectrogram-plot.ts';
import {diagnosticPdf} from '../src/diagnostics/diagnostic-pdf.ts';
import {meshPathPlot,renderMeshPathSvg} from '../src/diagnostics/mesh-path.ts';
import {meshSurfacePlot,renderMeshSurfaceSvg} from '../src/diagnostics/mesh-surface.ts';

const signal=new AbortController().signal;
const text=(file:string)=>execFileSync('pdftotext',[file,'-'],{encoding:'utf8'});
test('temperature CLI PDF preserves both vector panels and embeds readable fonts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'diagnostic-pdf-'));
 try{
  const file=join(dir,'temperature.pdf');
  execFileSync(process.execPath,[fileURLToPath(new URL('../../scripts/graph_temp_sensor.ts',import.meta.url)),'-s','Generic 3950,PT1000','-o',file]);
  assert.match(execFileSync('pdfinfo',[file],{encoding:'utf8'}),/Page size:\s+800 x 1200 pts/);
  assert.match(text(file),/ADC resolution/);assert.match(text(file),/Generic 3950/);assert.match(text(file),/PT1000/);
  assert.doesNotMatch((await readFile(file)).toString('latin1'),/\/Subtype \/Image/);
  assert.match(execFileSync('pdffonts',[file],{encoding:'utf8'}),/DejaVuSans[^\n]+yes\s+yes\s+yes/);
  const prefix=join(dir,'render');execFileSync('pdftoppm',['-r','72','-singlefile','-png',file,prefix]);
  const {data,info}=await sharp(prefix+'.png').removeAlpha().raw().toBuffer({resolveWithObject:true});
  assert.equal(info.width,800);assert.equal(info.height,1200);
  for(const offset of [0,600]){let colored=0;for(let y=offset+66;y<offset+400;y++)for(let x=84;x<764;x++){const i=(y*info.width+x)*3;if(Math.max(data[i],data[i+1],data[i+2])-Math.min(data[i],data[i+1],data[i+2])>50)colored++;}assert.ok(colored>300,`Missing curves in panel at ${offset}`);}
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('PDF retains embedded spectrogram matrix and logarithmic color scale',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spectrogram-pdf-'));
 try{
  const file=join(dir,'spectrum.pdf');
  await writeSpectrogram({frames:2,fftSize:2,sampleRate:4,frequencies:Float64Array.of(0,2),times:Float64Array.of(.25,.5),power:Float64Array.of(0,1,10,100)},'Spectrum check',2,file,signal);
  assert.match(text(file),/Spectrum check/);assert.match(text(file),/Log power/);
  assert.match((await readFile(file)).toString('latin1'),/\/Subtype \/Image/);
  const prefix=join(dir,'spectrum');execFileSync('pdftoppm',['-r','72','-singlefile','-png',file,prefix]);
  const {data,info}=await sharp(prefix+'.png').removeAlpha().raw().toBuffer({resolveWithObject:true});
  assert.equal(info.width,900);const pixel=(x:number,y:number)=>Array.from(data.subarray((y*info.width+x)*3,(y*info.width+x)*3+3));
  assert.deepEqual(pixel(200,100),[0,200,70]);assert.deepEqual(pixel(600,100),[255,200,0]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('failed and cancelled PDF exports preserve the prior file without temporary artifacts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'failed-pdf-'));
 try{
  const file=join(dir,'prior.pdf');await writeFile(file,'prior');
  await assert.rejects(writeStatsPanels(temperaturePlots(),file,AbortSignal.abort()),/abort/i);
  await assert.rejects(writePlotDocument({},()=>'<svg width="800" height="600"><image href="/etc/passwd" width="10" height="10"/></svg>',file,signal),/External|rendering failed/);
  await assert.rejects(writePlotDocument({},()=>'<svg width="800" height="600"><use href="other.svg#x"/></svg>',file,signal),/External|rendering failed/);
  await assert.rejects(writePlotDocument({},()=>'<svg width="14401" height="600"></svg>',file,signal),/page limit/);
  await assert.rejects(writePlotDocument({},()=>'<svg width="800" height="600"><text>温度</text></svg>',file,signal),/font lacks U\+6E29/);
  const controller=new AbortController();await assert.rejects(writePlotDocument({},()=>{controller.abort();return '<svg width="800" height="600"></svg>';},file,controller.signal),/abort/i);
  assert.equal(await readFile(file,'utf8'),'prior');assert.deepEqual(await readdir(dir),['prior.pdf']);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('PDF validates dimensions and keeps non-ASCII mathematical labels readable',async()=>{
 await assert.rejects(diagnosticPdf('<svg></svg>',signal),/dimensions/);
 const dir=await mkdtemp(join(tmpdir(),'unicode-pdf-'));
 try{
  const file=join(dir,'unicode.pdf');const panels=temperaturePlots({sensors:['PT1000'],resistance:true});panels[0].plot.title='ΔT ± 1°C; Ω';
  await writeStatsPanels(panels,file,signal);assert.match(text(file),/ΔT ± 1°C; Ω/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('mesh PDF preserves travel markers, surface polygons and legends',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mesh-pdf-'));
 try{
  const path=meshPathPlot({calibration:{points:[[10,10],[20,20],[30,30]],probe_path:[[10,10],[20,20],[30,30]]}},'path');
  const surface=meshSurfacePlot({current_mesh:{name:'measured',mesh_params:{min_x:0,max_x:100,min_y:0,max_y:100,x_count:2,y_count:2},probed_matrix:[[0,1],[2,3]],mesh_matrix:[[0,1],[2,3]]}},'probedz');
  for(const [name,svg] of [['path',renderMeshPathSvg(path)],['surface',renderMeshSurfaceSvg(surface)]]){
   const file=join(dir,name+'.pdf');await writePlotDocument({},()=>svg,file,signal);
   const contents=text(file);assert.match(contents,name==='path'?/Start: green triangle/:/measured/);
   assert.doesNotMatch((await readFile(file)).toString('latin1'),/\/Subtype \/Image/);
   execFileSync('pdftoppm',['-r','36','-singlefile','-png',file,join(dir,name)]);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
