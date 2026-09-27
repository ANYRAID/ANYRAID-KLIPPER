import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {motanColor,motanSvgColor} from '../src/motan/colors.ts';
import {motanNamedColors} from '../src/motan/colors-data.ts';
import {motanGraphPanels,parseMotanGraphs} from '../src/motan/graph.ts';
import {renderMotanGraph} from '../src/motan/graph-render.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/motan-colors.json',import.meta.url),'utf8'));
test('string colors and alpha exactly match 96 captured Matplotlib resolutions',()=>{
 assert.equal(Object.keys(motanNamedColors).length,reference.namedCount);assert.equal(reference.namedCount,1163);assert.equal(reference.cases.length,96);
 for(const row of reference.cases)assert.deepEqual(motanColor(row.color,row.alpha??undefined),row.expected,`${row.color}/${row.alpha}`);
 for(const color of reference.invalid)assert.throws(()=>motanColor(color),Error,color);
 for(const alpha of [-.1,1.1,NaN,Infinity])assert.throws(()=>motanColor('red',alpha));
 assert.throws(()=>motanColor('x'.repeat(4097)));const rgba=motanColor('red');(rgba as unknown as number[])[0]=0;assert.deepEqual(motanColor('red'),[1,0,0,1]);
});
test('SVG color output preserves byte colors and exact fractional base/grayscale channels',()=>{
 assert.equal(motanSvgColor(motanColor('green')),'#008000');assert.equal(motanSvgColor(motanColor('g')),'rgb(0%,50%,0%)');assert.equal(motanSvgColor(motanColor('c')),'rgb(0%,75%,75%)');assert.equal(motanSvgColor(motanColor('.5')),'rgb(50%,50%,50%)');assert.equal(motanSvgColor(motanColor('#abcd')),'#aabbcc');
 assert.throws(()=>motanSvgColor([NaN,0,0,1]));
});
test('transparent color hides artists but not legend text; plot alpha overrides embedded alpha',()=>{
 const analysis={times:Float64Array.of(0,1),datasets:{a:Float64Array.of(1,2)},labels:{a:{name:'a',label:'Visible label',units:'mm'}}};
 const render=(color:string,extra='')=>renderMotanGraph(motanGraphPanels(analysis,parseMotanGraphs(`[['a?color=${encodeURIComponent(color)}${extra}']]`),'capture'));
 const none=render('none');assert.match(none,/stroke="none"/);assert.match(none,/<g data-curve-label="Visible label" opacity="0.8">/);assert.match(none,/<g><title>Visible label<\/title><path opacity="0.8"/);assert.ok(!none.includes('<g opacity="0.8"><title>'));
 assert.match(render('#12345600'),/data-curve-label="Visible label" opacity="0.8"/);
 assert.match(render('#123456ff','&alpha=.25'),/data-curve-label="Visible label" opacity="0.25"/);
 assert.match(render('xkcd:sky blue'),/stroke="#75bbfd"/);
});
