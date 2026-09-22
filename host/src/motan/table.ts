import type {DatasetLabel} from './log-manager.ts';
/** Preformatted structured JSON cell. Distinct from a source string and from
 * numeric operands; the tag survives worker structured cloning. */
export interface MotanStructuredCell {readonly kind:'python-repr';readonly text:string;}
export type MotanScalar=number|string|bigint|boolean|null|MotanStructuredCell;
const cellBytes=new WeakMap<object,number>();
export function isMotanStructuredCell(value:unknown):value is MotanStructuredCell{
 if(value===null||typeof value!=='object')return false;
 const kind=Object.getOwnPropertyDescriptor(value,'kind'),text=Object.getOwnPropertyDescriptor(value,'text');
 return kind?.value==='python-repr'&&typeof text?.value==='string'&&Object.keys(value).length===2;
}
export function motanStructuredCell(text:string):MotanStructuredCell{
 return Object.freeze({kind:'python-repr',text});
}
export interface MotanTable {times:Float64Array;datasets:Readonly<Record<string,Float64Array|readonly MotanScalar[]>>;labels:Readonly<Record<string,DatasetLabel>>;}
/** Conservative payload charge, not an engine heap/RSS estimate. */
export function motanScalarBytes(value:unknown):number{
 if(value===null||typeof value==='boolean')return 8;
 if(typeof value==='number'&&Number.isFinite(value))return 8;
 if(typeof value==='string')return 8+value.length*2+Buffer.byteLength(value);
 if(typeof value==='bigint')return 8+value.toString().length*2;
 if(value!==null&&typeof value==='object'){
  const cached=cellBytes.get(value);if(cached!==undefined)return cached;
  if(isMotanStructuredCell(value)){const bytes=32+value.text.length*2+Buffer.byteLength(value.text);if(Object.isFrozen(value))cellBytes.set(value,bytes);return bytes;}
 }
 throw new Error('Motan table requires finite scalar values');
}
