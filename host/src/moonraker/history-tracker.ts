// Moonraker common.py tracker semantics. GPL-3.0-or-later.
// Original Copyright (C) 2023 Eric Callahan.
import {ApiError,validateJson,type Json} from './rpc.ts';
import {boundedJsonBytes} from './json-size.ts';

export const historyStrategies=['basic','delta','accumulate','average','maximum','minimum','collect'] as const;
export type HistoryStrategy=typeof historyStrategies[number];
export type HistoryNumberType='float'|'integer';
export interface HistoryTrackerOptions {
 strategy:HistoryStrategy;
 trackingEnabled:(excludePaused:boolean)=>boolean;
 excludePaused?:boolean;
 reset?:()=>Json;
 numberType?:HistoryNumberType;
}
// Python treats bool as an int, including inside list/dict equality.
function numeric(value:Json):number|undefined{return typeof value==='boolean'?Number(value):typeof value==='number'?value:undefined;}
function equal(a:Json,b:Json):boolean{
 if(a===b)return true;
 const x=numeric(a),y=numeric(b);if(x!==undefined&&y!==undefined)return x===y;
 if(a===null||b===null||typeof a!=='object'||typeof b!=='object')return false;
 if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>equal(v,b[i]));
 const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k]));
}
function snapshot(value:Json):Json{
 if(typeof value==='number'){finite(value);return value;}
 if(value===null||typeof value==='boolean')return value;
 validateJson(value);boundedJsonBytes(value,65536);return typeof value==='string'?value:structuredClone(value);
}
function bytes(value:Json):number{return typeof value==='number'?String(value).length:boundedJsonBytes(value,65536);}
function finite(value:number):number{if(!Number.isFinite(value))throw new ApiError(422,'History tracker overflow');return value;}

/** Per-field, per-runtime state; no process-global history singleton. Updates
 * do no I/O. JSON ownership and a 64 KiB retained-value limit bound snapshots. */
export class HistoryTracker {
 readonly #strategy:HistoryStrategy;readonly #enabled:HistoryTrackerOptions['trackingEnabled'];
 #reset:HistoryTrackerOptions['reset'];#exclude:boolean;#value:Json;#last:number|undefined;#count=0;#initialized=false;
 #sizes:number[]=[];#collectionBytes=2;
 readonly #numberType:HistoryNumberType;#resetNumberType:HistoryNumberType;#floating=false;#lastFloating=false;
 constructor(options:HistoryTrackerOptions){
  if(!historyStrategies.includes(options.strategy)||typeof options.trackingEnabled!=='function'||options.reset!==undefined&&typeof options.reset!=='function'||options.excludePaused!==undefined&&typeof options.excludePaused!=='boolean')throw new ApiError(400,'Invalid history tracker options');
  this.#strategy=options.strategy;this.#enabled=options.trackingEnabled;this.#reset=options.reset;this.#exclude=options.excludePaused??false;this.#value=this.#strategy==='basic'?null:this.#strategy==='collect'?[]:0;
  this.#numberType=options.numberType??'float';if(!['float','integer'].includes(this.#numberType))throw new ApiError(400,'Invalid history number type');this.#resetNumberType=this.#numberType;
 }
 setResetCallback(callback:(()=>Json)|undefined,numberType:HistoryNumberType=this.#numberType):void{if(callback!==undefined&&typeof callback!=='function'||!['float','integer'].includes(numberType))throw new ApiError(400,'Invalid history reset callback');this.#reset=callback;this.#resetNumberType=numberType;}
 setExcludePaused(exclude:boolean):void{if(typeof exclude!=='boolean')throw new ApiError(400,'Invalid history pause flag');this.#exclude=exclude;}
 get value():Json{return structuredClone(this.#value);}
 get hasTotals():boolean{return this.#strategy!=='collect'&&numeric(this.#value)!==undefined;}
 get isFloat():boolean{return this.#floating;}
 get hasResetCallback():boolean{return this.#reset!==undefined;}
 get excludePaused():boolean{return this.#exclude;}
 #float(value:Json,type:HistoryNumberType):boolean{if(type!=='float'&&type!=='integer')throw new ApiError(400,'Invalid history number type');if(typeof value!=='number')return false;if(type==='integer'&&!Number.isSafeInteger(value))throw new ApiError(422,'Unsafe history integer');return type==='float';}
 reset():void{
  // Capture/validate before changing state, so a bad callback cannot partially reset it.
  const returned=this.#reset?.();
  if(returned&&typeof (returned as {then?:unknown}).then==='function'){void Promise.resolve(returned).catch(()=>{});throw new ApiError(502,'History reset callback must be synchronous');}
  let initial=this.#reset?snapshot(returned!):undefined;
  const floating=initial===undefined?false:this.#float(initial,this.#resetNumberType);
  if(!floating&&typeof initial==='number'&&initial===0)initial=0;
  if(this.#strategy==='basic'){if(initial!==undefined){this.#value=initial;this.#floating=floating;}return;}
  if(this.#strategy==='collect'){this.#value=Array.isArray(initial)?initial:[];this.#sizes=this.#value.map(bytes);this.#collectionBytes=2+this.#sizes.reduce((a,b)=>a+b,0)+Math.max(0,this.#sizes.length-1);return;}
  const number=initial===undefined?undefined:numeric(initial);
  this.#last=this.#strategy==='delta'?number:undefined;this.#count=0;this.#initialized=number!==undefined;
  this.#value=this.#strategy==='delta'?0:number===undefined?0:initial!;
  this.#floating=this.#strategy==='delta'?false:floating;this.#lastFloating=floating;
 }
 update(value:Json,numberType:HistoryNumberType=this.#numberType):void{
  if(this.#strategy==='basic'){if(this.#enabled(this.#exclude)){const copy=snapshot(value),floating=this.#float(copy,numberType);this.#value=!floating&&typeof copy==='number'&&copy===0?0:copy;this.#floating=floating;}return;}
  if(this.#strategy==='collect'){
   if(!this.#enabled(this.#exclude))return;
   let copy=snapshot(value);const list=this.#value as Json[];
   if(typeof copy==='number'&&!this.#float(copy,numberType)&&copy===0)copy=0;
   const present=copy!==null&&typeof copy==='object'?list.some(item=>equal(item,copy)):
    list.includes(copy)||(typeof copy==='boolean'?list.includes(Number(copy)):copy===0||copy===1?list.includes(Boolean(copy)):false);
   if(present)return;
   const size=bytes(copy),evict=list.length>=100;
   const total=this.#collectionBytes+size+(list.length?1:0)-(evict?this.#sizes[0]+1:0);
   if(total>65536)throw new ApiError(413,'History collection byte limit exceeded');
   list.push(copy);this.#sizes.push(size);if(evict){list.shift();this.#sizes.shift();}this.#collectionBytes=total;return;
  }
  let number=numeric(value);if(number===undefined)return;
  finite(number);const floating=this.#float(value,numberType);
  if(!floating&&number===0){number=0;if(typeof value==='number')value=0;}
  const enabled=this.#enabled(this.#exclude),old=numeric(this.#value)!;
  if(this.#strategy==='delta'){
   const changes=enabled&&this.#last!==undefined,asFloat=this.#floating||floating||this.#lastFloating;
   let next=changes?finite(old+(number-this.#last!)):old;
   if(changes&&!asFloat){if(!Number.isSafeInteger(number-this.#last!))next=Number(BigInt(old)+BigInt(number)-BigInt(this.#last!));if(!Number.isSafeInteger(next))throw new ApiError(422,'History integer overflow');}
   this.#value=next;if(changes)this.#floating=asFloat;this.#last=number;this.#lastFloating=floating;return;
  }
  if(!enabled)return;
  let next:Json;
  let nextFloat=this.#floating||floating;
  switch(this.#strategy){
   case 'accumulate':next=finite(old+number);if(!nextFloat&&!Number.isSafeInteger(next))throw new ApiError(422,'History integer overflow');break;
   case 'average':{
    const count=this.#count+1;if(!Number.isSafeInteger(count))throw new ApiError(422,'History sample count overflow');
    next=finite((old*(count-1)+number)/count);this.#count=count;nextFloat=true;break;
   }
   case 'maximum':{const keep=this.#initialized&&old>=number;next=keep?this.#value:value;nextFloat=keep?this.#floating:floating;break;}
   case 'minimum':{const keep=this.#initialized&&old<=number;next=keep?this.#value:value;nextFloat=keep?this.#floating:floating;break;}
  }
  this.#value=next;this.#floating=nextFloat;this.#initialized=true;
 }
}
