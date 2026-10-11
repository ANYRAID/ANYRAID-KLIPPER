/** Explicit Python numeric kinds for native template callables. A JS Number
 * cannot distinguish Python integer 1 from float 1.0; integers use BigInt. */
export interface TemplateFloat {readonly kind:'float';readonly value:number;}
export type TemplateValue=null|boolean|string|bigint|TemplateFloat|readonly TemplateValue[]|ReadonlyMap<TemplateValue,TemplateValue>;
export type TemplateWire=readonly [string,...unknown[]];
export const templateFloatValue=(value:number):TemplateFloat=>{if(typeof value!=='number')throw new TypeError('Invalid template float');return Object.freeze({kind:'float',value});};
function fail():never{throw new TypeError('Invalid bounded template value');}
function encode(value:TemplateValue,depth:number,count:{value:number}):TemplateWire{
 if(depth>64||++count.value>65536)fail();
 if(value===null)return ['none'];
 if(typeof value==='boolean')return ['boolean',value];
 if(typeof value==='string'){if(!value.isWellFormed()||Buffer.byteLength(value)>65536)fail();return ['string',value];}
 if(typeof value==='bigint'){const text=String(value);if(text.length>4097)fail();return ['integer',text];}
 if(Array.isArray(value))return ['list',value.map(v=>encode(v,depth+1,count))];
 if(value instanceof Map)return ['map',[...value].map(([k,v])=>[encode(k,depth+1,count),encode(v,depth+1,count)])];
 if(value&&typeof value==='object'&&'kind'in value&&value.kind==='float'&&'value'in value&&typeof value.value==='number')return ['float',Number.isNaN(value.value)?'nan':value.value===Infinity?'inf':value.value===-Infinity?'-inf':Object.is(value.value,-0)?'-0':String(value.value)];
 return fail();
}
function decode(wire:unknown,depth:number,count:{value:number}):TemplateValue{
 if(depth>64||++count.value>65536||!Array.isArray(wire))fail();
 const [kind,value]=wire;
 if(kind==='none'&&wire.length===1)return null;
 if(wire.length!==2)fail();
 if(kind==='boolean'&&typeof value==='boolean')return value;
 if(kind==='string'&&typeof value==='string'&&value.isWellFormed())return value;
 if(kind==='integer'&&typeof value==='string'&&value.length<=4097&&/^-?(?:0|[1-9][0-9]*)$/.test(value))return BigInt(value);
 if(kind==='float'&&typeof value==='string'){
  if(value==='nan')return templateFloatValue(NaN);if(value==='inf')return templateFloatValue(Infinity);if(value==='-inf')return templateFloatValue(-Infinity);
  if(!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(value))fail();const number=Number(value);if(!Number.isFinite(number))fail();return templateFloatValue(number);
 }
 if(kind==='list'&&Array.isArray(value))return Object.freeze(value.map(v=>decode(v,depth+1,count)));
 if(kind==='map'&&Array.isArray(value)){const result=new Map<TemplateValue,TemplateValue>();for(const pair of value){if(!Array.isArray(pair)||pair.length!==2)fail();result.set(decode(pair[0],depth+1,count),decode(pair[1],depth+1,count));}return result;}
 return fail();
}
export function encodeTemplateValue(value:TemplateValue):string{const text=JSON.stringify(encode(value,0,{value:0}));if(Buffer.byteLength(text)>65536)fail();return text;}
export function decodeTemplateValue(text:string):TemplateValue{if(typeof text!=='string'||Buffer.byteLength(text)>65536)fail();return decode(JSON.parse(text),0,{value:0});}
export interface TemplateCall {readonly args:readonly TemplateValue[];readonly kwargs:ReadonlyMap<string,TemplateValue>;}
export function decodeTemplateCall(args:unknown,kwargs:unknown):TemplateCall{
 const count={value:0};if(!Array.isArray(args)||!Array.isArray(kwargs))fail();const named=new Map<string,TemplateValue>();
 for(const row of kwargs){if(!Array.isArray(row)||row.length!==2||typeof row[0]!=='string'||!row[0].isWellFormed()||Buffer.byteLength(row[0])>128||named.has(row[0]))fail();named.set(row[0],decode(row[1],0,count));}
 return {args:Object.freeze(args.map(arg=>decode(arg,0,count))),kwargs:named};
}
