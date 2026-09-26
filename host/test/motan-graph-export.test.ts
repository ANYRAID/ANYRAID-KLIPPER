import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import sharp from 'sharp';
import {renderMotanGraph,validateMotanGraphStyles} from '../src/motan/graph-render.ts';
import {parseMotanGraphs,motanGraphPanels} from '../src/motan/graph.ts';
import {writePlotDocument} from '../src/diagnostics/graphstats-file.ts';
import {managerFixture} from './helpers/motan-manager-fixture.ts';
const panels=()=>motanGraphPanels({times:Float64Array.of(0,.25,.5),datasets:{a:Float64Array.of(1,2,3)},labels:{a:{name:'a',label:'unsafe </script> " &',units:'Position\n(mm)'}}},parseMotanGraphs("[['a?color=green&alpha=.4&ls=--&lw=2&marker=o&ms=4']]"),'capture');
test('Motan styling preserves numeric axes, full labels, color, alpha, dashes and markers',()=>{
 const svg=renderMotanGraph(panels());assert.match(svg,/numeric horizontal axis/);assert.match(svg,/stroke="#008000"/);assert.match(svg,/opacity="0.4"/);assert.match(svg,/stroke-dasharray="6 4"/);assert.match(svg,/stroke-width="2"/);assert.equal((svg.match(/<circle/g)||[]).length,4);assert.match(svg,/Time \(s\)/);assert.ok(!svg.includes('</script>'));assert.match(svg,/&lt;\/script&gt;/);
 for(const parameter of ['color=url(x)','color=notacolor','alpha=2','lw=NaN','lw=2&linewidth=3','marker=x','drawstyle=unknown','label=ok&onload=bad'])assert.throws(()=>validateMotanGraphStyles(parseMotanGraphs(`[['a?${parameter}']]`)));
 const none=panels();none[0].curves[0].parameters.linestyle='none';delete none[0].curves[0].parameters.ls;const output=renderMotanGraph(none);assert.equal((output.match(/<circle/g)||[]).length,4);
});
test('Node Motan CLI exports actual captures in every main mode without a Python executable',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-graph-cli-')),prefix=join(dir,'capture with spaces'),cli=fileURLToPath(new URL('../../scripts/motan/motan_graph.ts',import.meta.url));
 const env={...process.env,PATH:'/no-python'},run=(args:string[])=>execFileSync(process.execPath,[cli,...args],{env,encoding:'utf8',timeout:15000});
 try{
  await managerFixture(prefix,2,'cartesian');
  const original=await readFile(prefix+'.json.gz');
  const graph="[['trapq(toolhead,x)?color=green&ds=steps-mid','derivative(trapq(toolhead,x))?color=tab:blue&alpha=.4'],['status(heater.temperature)?color=%23ff0000']]";
  for(const extension of ['json','svg','png','html','pdf']){
   const output=join(dir,'plot.'+extension);run([prefix,'-g',graph,'-d','.2','--segment-time','.01','-o',output]);
   const bytes=await readFile(output);assert.ok(bytes.length>100);
   if(extension==='json'){const plots=JSON.parse(bytes.toString());assert.equal(plots.length,2);assert.equal(plots[0].curves[0].parameters.color,'green');assert.ok(plots[0].curves[0].values.length>0);}
   if(extension==='svg')assert.match(bytes.toString(),/stroke="#1f77b4"/);
   if(extension==='png'){const info=await sharp(bytes).metadata();assert.equal(info.width,800);assert.equal(info.height,1200);}
   if(extension==='html'){assert.match(bytes.toString(),/Content-Security-Policy/);assert.match(bytes.toString(),/data-curve-label=/);}
   if(extension==='pdf')assert.ok(bytes.subarray(0,4).equals(Buffer.from('%PDF')));
  }
  run([prefix,'-d','.2','--segment-time','.01','-o',join(dir,'defaults.json')]);
  assert.equal(JSON.parse(await readFile(join(dir,'defaults.json'),'utf8')).length,3);
  assert.match(run(['-l']),/Available datasets/);assert.match(run(['-h']),/Usage:/);
  const output=join(dir,'keep.svg');await writeFile(output,'keep');
  for(const args of [[prefix,'-g',"[['trapq(toolhead,x)?color=url(x)']]",'-o',output],[prefix,'-d','NaN','-o',output],[prefix,'-g',"__import__('os')",'-o',output],[prefix,'-o',prefix+'.json.gz']])assert.equal(spawnSync(process.execPath,[cli,...args],{env,encoding:'utf8',timeout:15000}).status,1);
  assert.equal(await readFile(output,'utf8'),'keep');assert.deepEqual(await readFile(prefix+'.json.gz'),original);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('cancelled or invalid Motan render preserves prior output',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-graph-cancel-')),output=join(dir,'plot.svg');
 try{await writeFile(output,'keep');await assert.rejects(writePlotDocument(panels(),()=>renderMotanGraph(panels()),output,AbortSignal.abort()));const invalid=panels();invalid[0].curves[0].parameters.color='url(x)';await assert.rejects(writePlotDocument(invalid,()=>renderMotanGraph(invalid),output,new AbortController().signal));assert.equal(await readFile(output,'utf8'),'keep');}finally{await rm(dir,{recursive:true,force:true});}
});

test('mixed single and dual-axis panels share the same horizontal geometry and marker palette',()=>{
 const a=panels(),b=panels()[0];
 a[0].axes.push('Velocity');b.curves[0].parameters={label:'one',linestyle:'none',marker:'o'};b.curves.push({...b.curves[0],parameters:{label:'two',linestyle:'none',marker:'o'}});
 const svg=renderMotanGraph([...a,b]);
 const widths=[...svg.matchAll(/<clipPath id="panel\d+"><rect[^>]*width="([^"]+)"/g)].map(m=>m[1]);assert.deepEqual(widths,['616','616']);
 const legends=[...svg.matchAll(/<g opacity="[^"]+"><title>[\s\S]*?<\/g>/g)];assert.match(legends.at(-1)![0],/fill="#dc2626"/);
});
