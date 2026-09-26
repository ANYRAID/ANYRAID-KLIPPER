// GPL-3.0-or-later. String color semantics compatible with default Matplotlib.
import {parsePythonFloat} from '../moonraker/config-reader.ts';
import {motanNamedColors,motanColorCycle} from './colors-data.ts';
export type MotanRgba=readonly [number,number,number,number];
export function motanColor(value:string,alpha?:number):MotanRgba{
 if(typeof value!=='string'||value.length>4096||alpha!==undefined&&(!Number.isFinite(alpha)||alpha<0||alpha>1))throw new Error('Invalid Motan color or alpha');
 if(value.toLowerCase()==='none')return [0,0,0,0];
 let rgb:readonly number[]|undefined;
 if(/^C\d+$/.test(value))rgb=motanColorCycle[Number(BigInt(value.slice(1))%BigInt(motanColorCycle.length))];
 else{
  const key=Object.hasOwn(motanNamedColors,value)?value:value.length===1?value:value.toLowerCase();
  if(Object.hasOwn(motanNamedColors,key))rgb=motanNamedColors[key];
 }
 if(rgb)return [rgb[0],rgb[1],rgb[2],alpha??1];
 if(/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)){
  const hex=value.length<=5?[...value.slice(1)].map(c=>c+c).join(''):value.slice(1);
  return [parseInt(hex.slice(0,2),16)/255,parseInt(hex.slice(2,4),16)/255,parseInt(hex.slice(4,6),16)/255,alpha??(hex.length===8?parseInt(hex.slice(6,8),16)/255:1)];
 }
 let gray:number;try{gray=parsePythonFloat(value);}catch{throw new Error('Unsupported Motan color');}
 if(!Number.isFinite(gray)||gray<0||gray>1)throw new Error('Invalid grayscale color');
 return [gray,gray,gray,alpha??1];
}
/** Preserve fractional channels instead of quantizing base/gray colors to bytes. */
export function motanSvgColor(rgba:MotanRgba):string{
 const rgb=rgba.slice(0,3);
 if(rgb.some(v=>!Number.isFinite(v)||v<0||v>1))throw new Error('Invalid RGB channels');
 if(rgb.every(v=>Number.isInteger(v*255)))return '#'+rgb.map(v=>(v*255).toString(16).padStart(2,'0')).join('');
 return `rgb(${rgb.map(v=>`${v*100}%`).join(',')})`;
}
