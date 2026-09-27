import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {motanMarkers,prepareMotanMarker} from '../src/motan/markers.ts';
import {parseMotanGraphs,motanGraphPanels} from '../src/motan/graph.ts';
import {renderMotanGraph,validateMotanGraphStyles} from '../src/motan/graph-render.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/motan-marker-reference.json',import.meta.url),'utf8'));
test('all 150 marker and fill combinations retain upstream transformed control points and closure',()=>{
 assert.equal(Object.keys(reference.markers).length,25);let cases=0;
 for(const [name,styles]of Object.entries(reference.markers))for(const [fill,value]of Object.entries(styles as any)){
  const row=value as any,marker=prepareMotanMarker(name,fill,8,1,'test');cases++;
  const paths=[...marker.definitions.matchAll(/ d="([^"]*)"/g)].map(m=>m[1]);assert.equal(paths.length,row.alt?2:1);
  for(const [index,geometry]of [row.main,row.alt].filter(Boolean).entries()){
   const actual=[...paths[index].matchAll(/(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?),(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/gi)].map(m=>[Number(m[1]),Number(m[2])]);
   const scale=name===','?1:8,expected=geometry.vertices.filter((_v:any,i:number)=>geometry.codes[i]!==79).map(([x,y]:number[])=>[x*scale||0,-y*scale||0]);assert.deepEqual(actual.map(p=>p.map(n=>n||0)),expected,name+'/'+fill);
   assert.equal((paths[index].match(/Z/g)||[]).length,geometry.codes.filter((v:number)=>v===79).length);
  }
 }
 assert.equal(cases,150);assert(motanMarkers.includes('x'));
});
function graph(extra:string){return motanGraphPanels({times:Float64Array.of(0,1,2),datasets:{a:Float64Array.of(1,2,3)},labels:{a:{name:'a',label:'A',units:'mm'}}},parseMotanGraphs(`[['a?${extra}']]`),'markers');}
test('half-filled markers keep sample positions, distinct face and edge colors and matching legends',()=>{
 const panels=graph('marker=s&fillstyle=left&mfc=red&mfcalt=blue&mec=green&mew=2&ds=steps-mid&ls=none'),original=JSON.stringify(panels),svg=renderMotanGraph(panels);
 const curve=/<g data-curve-label="A"[^>]*>([\s\S]*?)<\/g>/.exec(svg)![1],legend=/<g><title>A<\/title>([\s\S]*?)<\/g>/.exec(svg)![1];
 assert.equal((curve.match(/<use /g)||[]).length,6);assert.equal((legend.match(/<use /g)||[]).length,2);
 for(const part of [curve,legend]){assert.match(part,/fill="#ff0000"/);assert.match(part,/fill="#0000ff"/);assert.match(part,/stroke="#008000" stroke-width="2"/);}
 assert.equal(JSON.stringify(panels),original);assert.equal((svg.match(/id="motan-marker-0-main"/g)||[]).length,1);
 const independent=renderMotanGraph(graph('color=none&marker=s&mfc=red'));assert.match(independent,/fill="#ff0000"/);assert.match(independent,/stroke="none"/);assert(!independent.includes('opacity="0"'));
});
test('marker validation rejects unsupported injection, aliases and sizes before analysis',()=>{
 for(const params of ['marker=url(x)','marker=s&fillstyle=bad','marker=s&mfc=url(x)','marker=s&mew=-1','marker=s&mew=21','marker=s&ms=41','marker=s&mfc=red&markerfacecolor=blue'])assert.throws(()=>validateMotanGraphStyles(parseMotanGraphs(`[['a?${params}']]`)));
 assert.equal(prepareMotanMarker('s','full',0,1,'test').definitions,'');assert(prepareMotanMarker(',','full',0,1,'test').definitions);
});

test('interactive marker references resolve only to generated paths',async()=>{
 const {renderInteractivePlot}=await import('../src/diagnostics/interactive-plot.ts');
 const svg=renderMotanGraph(graph('marker=X'));assert.match(renderInteractivePlot(svg),/data-marker="X"/);
 for(const target of ['#missing','https://example.com/a.svg#x','data:image/svg+xml,bad','#motan-marker-999-main'])assert.throws(()=>renderInteractivePlot(svg.replaceAll('#motan-marker-0-main',target)),/references/);
 assert.throws(()=>renderInteractivePlot(svg.replace('<defs>','<defs><path id="motan-marker-0-main" d="M0,0"/>')),/Duplicate/);
});
