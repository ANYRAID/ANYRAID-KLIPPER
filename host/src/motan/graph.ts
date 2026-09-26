// GPL-3.0-or-later. Motion plot layout from motan_graph.py, Kevin O'Connor.
import {parseLiteral} from '../diagnostics/python-literal.ts';
import {parsePythonFloat} from '../moonraker/config-reader.ts';
import {pythonStrip} from '../moonraker/metadata-values.ts';
import type {MotanAnalysis} from './analyzer.ts';
export interface MotanGraphSeries {dataset:string;parameters:Readonly<Record<string,string|number>>;}
export interface MotanGraphCurve {axis:0|1;times:number[];values:number[];parameters:Record<string,string|number>;}
export interface MotanGraphPanel {title:string;axes:string[];xLabel:string;curves:MotanGraphCurve[];}
export const defaultMotanGraphs=[
 ['trapq(toolhead,velocity)?color=green'],
 ['trapq(toolhead,accel)?color=green'],
 ['deviation(stepq(stepper_x),kin(stepper_x))?color=blue'],
] as const;
export function parseMotanGraphs(description?:string):readonly (readonly MotanGraphSeries[])[]{
 if(description!==undefined&&(typeof description!=='string'||Buffer.byteLength(description)>65536))throw new RangeError('Graph description limit');
 const rows=description===undefined?defaultMotanGraphs:parseLiteral(description);
 if(!Array.isArray(rows)||!rows.length||rows.length>8)throw new RangeError('Expected 1 to 8 graph panels');
 let count=0;
 return Object.freeze(rows.map(row=>{
  if(!Array.isArray(row)||!row.length||row.length>128||(count+=row.length)>256)throw new RangeError('Graph series limit');
  return Object.freeze(row.map((value:unknown)=>{
   if(typeof value!=='string'||value.length>4096)throw new TypeError('Expected graph dataset string');
   const separator=value.indexOf('?'),dataset=pythonStrip(separator<0?value:value.slice(0,separator));
   if(!dataset)throw new Error('Empty graph dataset');
   const parameters:Record<string,string|number>=Object.create(null);
   if(separator>=0)for(const [key,text] of new URLSearchParams(value.slice(separator+1))){
    if(!text)continue; // urllib.parse.parse_qsl drops blank values; final duplicate wins.
    const result=key==='alpha'?parsePythonFloat(text):text;
    if(typeof result==='number'&&(!Number.isFinite(result)||result<0||result>1))throw new RangeError('Graph alpha must be between 0 and 1');
    parameters[key]=result;
   }
   return Object.freeze({dataset,parameters:Object.freeze(parameters)});
  }));
 }));
}
export function motanGraphDatasets(graphs:readonly (readonly MotanGraphSeries[])[]):string[]{
 return [...new Set(graphs.flatMap(row=>row.map(series=>series.dataset)))];
}
function copyNumbers(values:Float64Array):number[]{
 const copy=new Array<number>(values.length);
 for(let i=0;i<values.length;i++){
  const value=values[i];if(!Number.isFinite(value))throw new Error('Nonfinite motion graph dataset');copy[i]=value;
 }
 return copy;
}
/** Preserve all samples and legacy unit-to-axis decisions; rendering is separate. */
export function motanGraphPanels(analysis:MotanAnalysis,graphs:readonly (readonly MotanGraphSeries[])[],logPrefix:string):MotanGraphPanel[]{
 if(typeof logPrefix!=='string'||logPrefix.length>4096||!Array.isArray(graphs)||!graphs.length||graphs.length>8)throw new RangeError('Invalid motion graph request');
 if(!(analysis.times instanceof Float64Array)||analysis.times.length>1000000||!analysis.times.every(Number.isFinite))throw new Error('Invalid motion graph times');
 let total=0;
 for(const row of graphs){
  if(!row.length||row.length>128||row.length*analysis.times.length>500000)throw new RangeError('Motion graph panel point limit');
  for(const series of row){
   const values=Object.hasOwn(analysis.datasets,series.dataset)?analysis.datasets[series.dataset]:undefined,label=Object.hasOwn(analysis.labels,series.dataset)?analysis.labels[series.dataset]:undefined;
   if(!(values instanceof Float64Array)||values.length!==analysis.times.length||!label||typeof label.label!=='string'||typeof label.units!=='string')throw new Error('Missing or nonfinite motion graph dataset');
   total+=values.length;if(total>1000000)throw new RangeError('Motion graph total point limit');
  }
 }
 return graphs.map((row,index)=>{
  let primary:string|undefined,secondary:string|undefined;
  const axes:string[]=[],curves:MotanGraphCurve[]=[];
  for(const series of row){
   const label=analysis.labels[series.dataset];let axis:0|1=0;
   if(primary===undefined){primary=label.units;axes[0]=primary;}
   else if(label.units!==primary){
    if(secondary===undefined){axis=1;secondary=label.units;axes[1]=secondary;}
    else if(label.units===secondary)axis=1;
    else{primary='Unknown';axes[0]=primary;}
   }
   curves.push({axis,times:copyNumbers(analysis.times),values:copyNumbers(analysis.datasets[series.dataset]),parameters:{label:label.label,alpha:.8,...series.parameters}});
  }
  return {title:index===0?`Motion Analysis (${logPrefix})`:'',axes,xLabel:index===graphs.length-1?'Time (s)':'',curves};
 });
}
