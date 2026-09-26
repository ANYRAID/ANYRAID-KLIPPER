import {motanColor,motanSvgColor} from './colors.ts';
import {motanDrawStyles,motanStepPointCount,motanStepVertices,type MotanDrawStyle} from './step-plot.ts';
// GPL-3.0-or-later. Validated Motan styles over the shared diagnostic renderer.
import {renderStatsPanels} from '../diagnostics/stats-svg.ts';
import type {MotanGraphPanel,MotanGraphSeries} from './graph.ts';
const dashes:Record<string,string>={'-':'',solid:'','--':'6 4',dashed:'6 4','-.':'6 3 1 3',dashdot:'6 3 1 3',':':'1 3',dotted:'1 3',none:'none',None:'none',' ':'none'};
interface Style {color?:string;alpha:number;width:number;dash:string;marker:string;size:number;drawstyle:MotanDrawStyle;}
function style(parameters:Readonly<Record<string,string|number>>):Style{
 const allowed=new Set(['label','alpha','color','c','linewidth','lw','linestyle','ls','marker','markersize','ms','drawstyle','ds']);
 for(const key of Object.keys(parameters))if(!allowed.has(key))throw new Error(`Unsupported Motan plot parameter: ${key}`);
 const alias=(a:string,b:string,fallback:string|number)=>{if(parameters[a]!==undefined&&parameters[b]!==undefined)throw new Error(`Conflicting plot aliases: ${a}/${b}`);return parameters[a]??parameters[b]??fallback;};
 const numeric=(value:string|number,name:string,min:number,max:number)=>{if(typeof value==='string'&&!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))throw new Error(`Invalid plot ${name}`);const n=Number(value);if(!Number.isFinite(n)||n<min||n>max)throw new Error(`Invalid plot ${name}`);return n;};
 const rawColor=alias('color','c',''),opacity=numeric(parameters.alpha??.8,'alpha',0,1);
 if(typeof rawColor!=='string')throw new Error('Invalid plot color');
 const rgba=rawColor===''?undefined:motanColor(rawColor,opacity),color=rgba?motanSvgColor(rgba):undefined;
 const line=alias('linestyle','ls','-'),marker=parameters.marker??'none',drawstyle=alias('drawstyle','ds','default');
 if(typeof drawstyle!=='string'||!motanDrawStyles.includes(drawstyle))throw new Error('Unsupported plot drawstyle');
 if(typeof line!=='string'||!Object.hasOwn(dashes,line)||!['none','None','','.','o'].includes(String(marker)))throw new Error('Unsupported plot line or marker style');
 if(parameters.label!==undefined&&typeof parameters.label!=='string')throw new Error('Invalid plot label');
 return {color,drawstyle:drawstyle as MotanDrawStyle,alpha:rgba?.[3]??opacity,width:numeric(alias('linewidth','lw',1.4),'linewidth',0,20),dash:dashes[line],marker:String(marker),size:numeric(alias('markersize','ms',4),'markersize',0,40)};
}
export function validateMotanGraphStyles(graphs:readonly (readonly MotanGraphSeries[])[]):void{for(const row of graphs)for(const series of row)style(series.parameters);}
export function renderMotanGraph(panels:readonly MotanGraphPanel[]):string{
 const styles=panels.flatMap(p=>p.curves.map(c=>style(c.parameters)));
 let rendered=0,series=0;for(const panel of panels)for(const curve of panel.curves){rendered+=motanStepPointCount(curve.times.length,styles[series++].drawstyle);if(rendered>500000)throw new RangeError('Combined step plot point capacity exceeded');}
 let svg=renderStatsPanels(panels.map(panel=>({plot:{title:panel.title,axes:panel.axes,curves:panel.curves.map(c=>({axis:c.axis,label:String(c.parameters.label??''),times:c.times,values:c.values,style:'line' as const}))},xAxis:{label:panel.xLabel,format:'number' as const},fullLegend:true,reserveRightAxis:panels.some(p=>p.axes.length===2)})));
 let index=0;
 svg=svg.replace(/<g data-curve-label="[^"]*">[\s\S]*?<\/g>/g,group=>{
  const s=styles[index++];if(!s)throw new Error('Unexpected generated curve group');
  const path=/<path d="([^"]+)"/.exec(group)?.[1];
  if(path&&s.drawstyle!=='default'){
   const points=[...path.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)],vertices=motanStepVertices(points.map(p=>Number(p[1])),points.map(p=>Number(p[2])),s.drawstyle);
   const steps=vertices.x.map((x,i)=>`${i?'L':'M'}${x.toFixed(3)},${vertices.y[i].toFixed(3)}`).join('');group=group.replace(`d="${path}"`,`d="${steps}"`);
  }
  const fallback=/stroke="(#[0-9a-f]+)"/i.exec(group)?.[1]??'#15803d',color=s.color??fallback;
  if(s.color)group=group.replace(/(stroke|fill)="#[0-9a-f]+"/gi,(_,attribute)=>`${attribute}="${s.color}"`);
  group=group.replace(/stroke-width="[\d.]+"/g,`stroke-width="${s.width}"${s.dash&&s.dash!=='none'?` stroke-dasharray="${s.dash}"`:''}`);
  if(s.dash==='none')group=group.replace(/<path [^>]*\/>/g,'').replace(/<circle [^>]*\/>/g,'');
  if(path&&['.','o'].includes(s.marker))group=group.replace(/<circle [^>]*\/>/g,'');
  let markers='';
  if(path&&['.','o'].includes(s.marker))for(const match of path.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g))markers+=`<circle cx="${match[1]}" cy="${match[2]}" r="${s.size/(s.marker==='.'?4:2)}" fill="${color}"/>`;
  return group.replace('>',` opacity="${s.alpha}">`).replace('</g>',markers+'</g>');
 });
 if(index!==styles.length)throw new Error('Missing generated curve groups');
 index=0;
 svg=svg.replace(/<g><title>[\s\S]*?<\/g>/g,legend=>{
  const s=styles[index++];if(!s)throw new Error('Unexpected generated legend');
  const legendColor=s.color??/stroke="(#[0-9a-f]+)"/i.exec(legend)?.[1]??'#15803d';
  if(s.color)legend=legend.replace(/stroke="#[0-9a-f]+"/gi,`stroke="${s.color}"`);
  legend=legend.replace(/stroke-width="[\d.]+"/g,`stroke-width="${s.width}"${s.dash&&s.dash!=='none'?` stroke-dasharray="${s.dash}"`:''}`);
  if(s.dash==='none'||['.','o'].includes(s.marker))legend=legend.replace(/<path d="M([\d.]+) ([\d.]+)h14"[^>]*\/>/g,(path,x,y)=>(s.dash==='none'?'':path)+(['.','o'].includes(s.marker)?`<circle cx="${Number(x)+7}" cy="${y}" r="${s.size/(s.marker==='.'?4:2)}" fill="${legendColor}"/>`:''));
  return legend.replace(/<(path|circle) /g,`<$1 opacity="${s.alpha}" `);
 });
 if(index!==styles.length)throw new Error('Missing generated legends');
 if(Buffer.byteLength(svg)>64*1024**2)throw new RangeError('Motan graph output capacity exceeded');return svg;
}
