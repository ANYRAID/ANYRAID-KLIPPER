import type {DatasetLabel} from './log-manager.ts';
export type MotanScalar=number|string|bigint|boolean|null;
export interface MotanTable {times:Float64Array;datasets:Readonly<Record<string,Float64Array|readonly MotanScalar[]>>;labels:Readonly<Record<string,DatasetLabel>>;}
/** Conservative payload charge, not an engine heap/RSS estimate. */
export function motanScalarBytes(value:unknown):number{
 if(value===null||typeof value==='boolean')return 8;
 if(typeof value==='number'&&Number.isFinite(value))return 8;
 if(typeof value==='string')return 8+value.length*2+Buffer.byteLength(value);
 if(typeof value==='bigint')return 8+value.toString().length*2;
 throw new Error('Motan table requires finite scalar values');
}
