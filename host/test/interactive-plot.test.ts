import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {renderInteractivePlot} from '../src/diagnostics/interactive-plot.ts';
import {renderStatsPanels} from '../src/diagnostics/stats-svg.ts';
import {writeStatsPanels} from '../src/diagnostics/graphstats-file.ts';
import {temperaturePlots} from '../src/diagnostics/graph-temperature.ts';
const panels=()=>temperaturePlots({sensors:['Generic 3950','PT1000']});
const script=(html:string)=>{const match=/<script>([\s\S]*)<\/script>/.exec(html);assert(match);return match[1];};
test('interactive document preserves full SVG, escapes labels and authorizes only its exact script',()=>{
 const plots=panels();plots[0].plot.curves[0].label='</script><img src=x onerror=alert(1)>';const svg=renderStatsPanels(plots),html=renderInteractivePlot(svg);assert(html.includes(svg));assert(!html.includes('<img'));assert.equal((html.match(/<script>/g)||[]).length,1);assert.equal((svg.match(/data-curve-label=/g)||[]).length,4);assert(html.includes("script-src 'sha256-"+createHash('sha256').update(script(html)).digest('base64')+"'"));assert(html.includes("default-src 'none'"));assert(!html.includes('https://'));
 for(const bad of ['<svg onload="alert(1)"></svg>','<svg ><script>alert(1)</script></svg>','<svg ><foreignObject></foreignObject></svg>','<svg ><a href="https://example.com">x</a></svg>'])assert.throws(()=>renderInteractivePlot(bad));
});
class Element {
 style:Record<string,string>={};textContent='';hidden=false;checked=false;type='';children:any[]=[];parentElement:any={hidden:false};ownerSVGElement:any;attrs:Record<string,string>={};events:Record<string,Function>={};onclick?:Function;
 append(...children:any[]){this.children.push(...children);}get childElementCount(){return this.children.length;}
 addEventListener(name:string,fn:Function){this.events[name]=fn;}setAttribute(k:string,v:string){this.attrs[k]=v;}getAttribute(k:string){return this.attrs[k];}
 querySelector(_q:string):any{return undefined;}querySelectorAll(_q:string):Element[]{return [];}
 setPointerCapture(_id:number){}getScreenCTM(){return {a:2,d:2};}
}
test('exported script handles zoom bounds, keyboard pan/reset, drag cancellation and independent curve toggles',()=>{
 const elements=Object.fromEntries(['viewport','status','in','out','reset','curves'].map(id=>[id,new Element()])),svg=new Element();svg.attrs.viewBox='0 0 800 1200';elements.viewport.querySelector=()=>svg;
 const groups=[new Element(),new Element()];for(const [i,g] of groups.entries()){g.attrs['data-curve-label']='sensor '+i;g.ownerSVGElement={querySelector:()=>({textContent:'ADC'})};}svg.querySelectorAll=()=>groups;
 runInNewContext(script(renderInteractivePlot(renderStatsPanels(panels()))),{document:{getElementById:(id:string)=>elements[id],createElement:()=>new Element(),createTextNode:(s:string)=>s}});
 assert.equal(elements.status.textContent,'Zoom 100%');elements.in.onclick!();assert.equal(elements.status.textContent,'Zoom 150%');for(let i=0;i<30;i++)elements.in.onclick!();assert.equal(elements.status.textContent,'Zoom 3200%');for(let i=0;i<30;i++)elements.out.onclick!();assert.equal(elements.status.textContent,'Zoom 25%');elements.reset.onclick!();assert.equal(svg.attrs.viewBox,'0 0 800 1200');
 let prevented=0;elements.viewport.events.keydown({key:'ArrowRight',preventDefault(){prevented++;}});assert.equal(svg.attrs.viewBox,'80 0 800 1200');elements.viewport.events.keydown({key:'0',preventDefault(){prevented++;}});assert.equal(prevented,2);
 svg.events.pointerdown({button:0,pointerId:1,clientX:10,clientY:20});svg.events.pointermove({pointerId:1,clientX:30,clientY:60});assert.equal(svg.attrs.viewBox,'-10 -20 800 1200');svg.events.pointercancel();svg.events.pointermove({pointerId:1,clientX:100,clientY:100});assert.equal(svg.attrs.viewBox,'-10 -20 800 1200');
 const checkbox=elements.curves.children[0].children[0] as Element;checkbox.checked=false;checkbox.events.change();assert.equal(groups[0].style.display,'none');assert.equal(groups[1].style.display,undefined);checkbox.checked=true;checkbox.events.change();assert.equal(groups[0].style.display,'');
});
test('HTML export is atomic, cancellable and supported through shared panel output',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'interactive-plot-')),file=join(dir,'plot.html');try{await writeStatsPanels(panels(),file,new AbortController().signal);const html=await readFile(file,'utf8');assert(html.startsWith('<!doctype html>'));await writeFile(file,'prior');await assert.rejects(writeStatsPanels(panels(),file,AbortSignal.abort()));assert.equal(await readFile(file,'utf8'),'prior');assert.deepEqual(await readdir(dir),['plot.html']);}finally{await rm(dir,{recursive:true,force:true});}
});

test('shared HTML export supports mesh geometry and embedded PNG spectrograms without external references',async()=>{
 const {meshSurfacePlot,renderMeshSurfaceSvg}=await import('../src/diagnostics/mesh-surface.ts'),{writeSpectrogram}=await import('../src/diagnostics/spectrogram-plot.ts');
 const surface=meshSurfacePlot({current_mesh:{name:'measured',mesh_params:{min_x:0,max_x:100,min_y:0,max_y:100,x_count:2,y_count:2},probed_matrix:[[0,1],[2,3]],mesh_matrix:[[0,1],[2,3]]}},'probedz');assert(renderInteractivePlot(renderMeshSurfaceSvg(surface)).includes('<polygon'));
 const dir=await mkdtemp(join(tmpdir(),'spectrogram-html-'));try{const file=join(dir,'spectrum.html');await writeSpectrogram({frames:2,fftSize:2,sampleRate:4,frequencies:Float64Array.of(0,2),times:Float64Array.of(.25,.5),power:Float64Array.of(0,1,10,100)},'Spectrum',2,file,new AbortController().signal);assert((await readFile(file,'utf8')).includes('data:image/png;base64,'));}finally{await rm(dir,{recursive:true,force:true});}
 assert.throws(()=>renderInteractivePlot('<svg ><image href="https://example.com/a.png"/></svg>'),/External/);assert.throws(()=>renderInteractivePlot('<svg ><image href="data:image/svg+xml;base64,AAAA"/></svg>'),/External/);
});

test('path playback pauses, seeks, completes, replays and stops while hidden',()=>{
 const elements=Object.fromEntries(['viewport','status','in','out','reset','curves','animation','play','seek','position'].map(id=>[id,new Element()])),svg=new Element(),travel=new Element();
 svg.attrs.viewBox='0 0 1000 760';elements.viewport.querySelector=()=>svg;
 const full='M0 0L1 0L2 1L2 2L3 3';travel.attrs.d=full;travel.attrs['data-mesh-animation']='1,2,4,5';svg.querySelector=q=>q==='[data-mesh-animation]'?travel:undefined;
 let next=0;const queued=new Map<number,Function>(),events:Record<string,Function>={};
 const document={hidden:false,getElementById:(id:string)=>elements[id],createElement:()=>new Element(),createTextNode:(s:string)=>s,addEventListener:(key:string,fn:Function)=>{events[key]=fn;}};
 runInNewContext(script(renderInteractivePlot('<svg viewBox="0 0 1000 760"></svg>')),{document,requestAnimationFrame:(fn:Function)=>{queued.set(++next,fn);return next;},cancelAnimationFrame:(id:number)=>queued.delete(id)});
 const advance=(now:number)=>{const callbacks=[...queued.values()];queued.clear();callbacks.forEach(fn=>fn(now));};
 assert.equal(travel.attrs.d,'M0 0');assert.equal(elements.position.textContent,'Point 1 / 5');assert.equal(elements.animation.hidden,false);
 elements.play.onclick!();advance(0);advance(60);assert.equal(travel.attrs.d,'M0 0L1 0');elements.play.onclick!();assert.equal(queued.size,0);assert.equal(elements.play.attrs['aria-pressed'],'false');
 (elements.seek as any).value='2';elements.seek.events.input();assert.equal(travel.attrs.d,'M0 0L1 0L2 1L2 2');assert.equal(queued.size,0);
 elements.play.onclick!();advance(100);advance(160);assert.equal(travel.attrs.d,full);assert.equal(elements.play.textContent,'Play');assert.equal(queued.size,0);
 elements.play.onclick!();assert.equal(travel.attrs.d,'M0 0');document.hidden=true;events.visibilitychange();assert.equal(queued.size,0);
 (elements.seek as any).value='NaN';elements.seek.events.input();assert.equal(travel.attrs.d,'M0 0');
});
