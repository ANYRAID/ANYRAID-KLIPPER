import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseMotanGraphs,motanGraphDatasets,motanGraphPanels} from '../src/motan/graph.ts';
import type {MotanAnalysis} from '../src/motan/analyzer.ts';
const contract=JSON.parse(readFileSync(new URL('../contracts/motan-graph-layout.json',import.meta.url),'utf8'));
test('motion graph complete arrays and dual-axis unit decisions match original Python',()=>{
 assert.equal(contract.cases.length,2);
 for(const row of contract.cases){
  const graphs=row.graphs.map((panel:any[])=>panel.map(([dataset,parameters])=>({dataset,parameters})));
  const analysis:MotanAnalysis={times:Float64Array.from(row.times),datasets:Object.fromEntries(Object.entries(row.datasets).map(([k,v])=>[k,Float64Array.from(v as number[])])),labels:row.labels};
  const panels=motanGraphPanels(analysis,graphs,'fixture');assert.deepEqual(panels,row.panels);
  const value=panels[0].curves[0].values[0];analysis.datasets.a[0]=999;assert.equal(panels[0].curves[0].values[0],value);
 }
});
test('graph descriptions retain URL parameters, final nonblank duplicate, defaults and independent labels',()=>{
 const graphs=parseMotanGraphs(`[[' a ?color=red&color=&color=green&alpha=.5&label=x+y%26z','a?linestyle=--','b'],['a?unknown=keep']]`);
 assert.deepEqual(motanGraphDatasets(graphs),['a','b']);
 assert.equal(graphs[0][0].dataset,'a');assert.equal(graphs[0][0].parameters.color,'green');assert.equal(graphs[0][0].parameters.alpha,.5);assert.equal(graphs[0][0].parameters.label,'x y&z');assert.equal(graphs[1][0].parameters.unknown,'keep');
 assert.equal(parseMotanGraphs().length,3);assert.ok(Object.isFrozen(graphs[0][0].parameters));
 for(const value of ['[]',"['a']","[[]]","[[1]]","[['?color=red']]","[['a?alpha=NaN']]","[['a?alpha=1.1']]","__import__('os')"])
  assert.throws(()=>parseMotanGraphs(value));
});
test('plot planning rejects missing, nonfinite, oversized or misaligned data before returning panels',()=>{
 const graphs=parseMotanGraphs("[['a']]");
 const analysis:MotanAnalysis={times:Float64Array.of(-0,1),datasets:{a:Float64Array.of(Number.MIN_VALUE,-0)},labels:{a:{name:'a',label:'label',units:'Unknown'}}};
 const result=motanGraphPanels(analysis,graphs,'capture');assert.ok(Object.is(result[0].curves[0].times[0],-0));assert.ok(Object.is(result[0].curves[0].values[1],-0));assert.equal(result[0].curves[0].values[0],Number.MIN_VALUE);
 assert.throws(()=>motanGraphPanels({...analysis,datasets:{}},graphs,'capture'),/dataset/);
 assert.throws(()=>motanGraphPanels({...analysis,datasets:{a:Float64Array.of(1)}},graphs,'capture'),/dataset/);
 assert.throws(()=>motanGraphPanels({...analysis,times:Float64Array.of(NaN)},graphs,'capture'),/times/);
 assert.throws(()=>motanGraphPanels({...analysis,datasets:{a:Float64Array.of(0,Infinity)}},graphs,'capture'),/dataset/);
 assert.throws(()=>motanGraphPanels({...analysis,times:new Float64Array(500001)},graphs,'capture'),/point limit/);
});

test('worker analysis of a real Motan capture feeds full graph panels without Python',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {managerFixture}=await import('./helpers/motan-manager-fixture.ts');
 const {MotanAnalysisExecutor}=await import('../src/motan/analysis-executor.ts');
 const directory=await mkdtemp(join(tmpdir(),'motan-graph-')),prefix=join(directory,'capture'),executor=new MotanAnalysisExecutor();
 try{
  await managerFixture(prefix);
  const graphs=parseMotanGraphs("[['trapq(toolhead,x)','derivative(trapq(toolhead,x))'],['status(heater.temperature)']]");
  const analysis=await executor.analyze({prefix,datasets:motanGraphDatasets(graphs),duration:.2,segmentTime:.01});
  const panels=motanGraphPanels(analysis,graphs,prefix);assert.equal(panels.length,2);assert.ok(panels[0].curves[0].times.length>0);
  assert.deepEqual(panels[0].curves[0].values,Array.from(analysis.datasets['trapq(toolhead,x)']));
  assert.deepEqual(panels[1].curves[0].times,Array.from(analysis.times));assert.equal(executor.status.busy,false);
 }finally{await executor.close();await rm(directory,{recursive:true,force:true});}
});
