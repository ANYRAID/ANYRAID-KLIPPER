import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {motanStepVertices,motanStepPointCount,type MotanDrawStyle} from '../src/motan/step-plot.ts';
import {motanGraphPanels,parseMotanGraphs} from '../src/motan/graph.ts';
import {renderMotanGraph,validateMotanGraphStyles} from '../src/motan/graph-render.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/motan-step-plot.json',import.meta.url),'utf8'));
test('all drawstyle vertices exactly match captured Matplotlib including signed zeros and reversed times',()=>{
 assert.equal(reference.cases.length,20);
 for(const row of reference.cases){const before=JSON.stringify(row);assert.deepEqual(motanStepVertices(row.x,row.y,row.drawstyle),row.expected);assert.equal(motanStepPointCount(row.x.length,row.drawstyle),row.expected.x.length);assert.equal(JSON.stringify(row),before);}
});
test('empty, single, nonfinite, overflow and expanded point limits are explicit',()=>{
 for(const kind of ['default','steps-pre','steps-post','steps-mid'] as MotanDrawStyle[])assert.deepEqual(motanStepVertices([],[],kind),{x:[],y:[]});
 assert.throws(()=>motanStepVertices([0],[1,2],'steps'),/mismatch/);
 assert.throws(()=>motanStepVertices([Infinity],[1],'steps'),/Nonfinite/);
 assert.throws(()=>motanStepVertices([Number.MAX_VALUE,Number.MAX_VALUE],[1,2],'steps-mid'),/overflow/);
 assert.throws(()=>motanStepVertices(Array(250001).fill(0),Array(250001).fill(1),'steps-mid'),/limit/);
 assert.throws(()=>validateMotanGraphStyles(parseMotanGraphs("[['a?ds=steps&drawstyle=steps-mid']]")),/Conflicting/);
 assert.throws(()=>validateMotanGraphStyles(parseMotanGraphs("[['a?drawstyle=invalid']]")),/drawstyle/);
});
test('SVG stairs retain original sample markers and full JSON data',()=>{
 const analysis={times:Float64Array.of(0,1,3),datasets:{a:Float64Array.of(1,4,2)},labels:{a:{name:'a',label:'A',units:'mm'}}};
 for(const kind of ['steps-pre','steps-post','steps-mid']){
  const panels=motanGraphPanels(analysis,parseMotanGraphs(`[['a?ds=${kind}&marker=o']]`),'capture'),before=JSON.stringify(panels),svg=renderMotanGraph(panels);
  const curve=/<g data-curve-label="A"[^>]*>([\s\S]*?)<\/g>/.exec(svg)![1];
  const path=/<path d="([^"]+)"/.exec(curve)![1];assert.equal((path.match(/[ML]/g)||[]).length,kind==='steps-mid'?6:5);
  assert.equal((curve.match(/<circle/g)||[]).length,3);assert.equal(JSON.stringify(panels),before);
  const coords=[...path.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map(m=>[Number(m[1]),Number(m[2])]);
  for(let i=1;i<coords.length;i++)assert.ok(coords[i][0]===coords[i-1][0]||coords[i][1]===coords[i-1][1]);
 }
});

test('single sample step curves have one marker instead of a duplicate implicit marker',()=>{
 const input={times:Float64Array.of(1),datasets:{a:Float64Array.of(2)},labels:{a:{name:'a',label:'A',units:'mm'}}};
 for(const kind of ['default','steps-pre','steps-post','steps-mid']){
  const svg=renderMotanGraph(motanGraphPanels(input,parseMotanGraphs(`[['a?drawstyle=${kind}&marker=o']]`),'capture'));
  const curve=/<g data-curve-label="A"[^>]*>([\s\S]*?)<\/g>/.exec(svg)![1];assert.equal((curve.match(/<circle/g)||[]).length,1);
 }
});
