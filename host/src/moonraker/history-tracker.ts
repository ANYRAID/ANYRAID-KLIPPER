// Moonraker common.py tracker semantics. GPL-3.0-or-later.
// Original Copyright (C) 2023 Eric Callahan.
import {ApiError,validateJson,type Json} from './rpc.ts';
import {boundedJsonBytes} from './json-size.ts';

export const historyStrategies=['basic','delta','accumulate','average','maximum','minimum','collect'] as const;
export type HistoryStrategy=typeof historyStrategies[number];
export interface HistoryTrackerOptions {
 strategy:HistoryStrategy;
 trackingEnabled:(excludePaused:boolean)=>boolean;
 excludePaused?:boolean;
 reset?:()=>Json;
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
 constructor(options:HistoryTrackerOptions){
  if(!historyStrategies.includes(options.strategy)||typeof options.trackingEnabled!=='function'||options.reset!==undefined&&typeof options.reset!=='function'||options.excludePaused!==undefined&&typeof options.excludePaused!=='boolean')throw new ApiError(400,'Invalid history tracker options');
  this.#strategy=options.strategy;this.#enabled=options.trackingEnabled;this.#reset=options.reset;this.#exclude=options.excludePaused??false;this.#value=this.#strategy==='basic'?null:this.#strategy==='collect'?[]:0;
 }
 setResetCallback(callback:(()=>Json)|undefined):void{if(callback!==undefined&&typeof callback!=='function')throw new ApiError(400,'Invalid history reset callback');this.#reset=callback;}
 setExcludePaused(exclude:boolean):void{if(typeof exclude!=='boolean')throw new ApiError(400,'Invalid history pause flag');this.#exclude=exclude;}
 get value():Json{return structuredClone(this.#value);}
 get hasTotals():boolean{return this.#strategy!=='collect'&&numeric(this.#value)!==undefined;}
 reset():void{
  // Capture/validate before changing state, so a bad callback cannot partially reset it.
  const initial=this.#reset?snapshot(this.#reset()):undefined;
  if(this.#strategy==='basic'){if(initial!==undefined)this.#value=initial;return;}
  if(this.#strategy==='collect'){this.#value=Array.isArray(initial)?initial:[];this.#sizes=this.#value.map(bytes);this.#collectionBytes=2+this.#sizes.reduce((a,b)=>a+b,0)+Math.max(0,this.#sizes.length-1);return;}
  const number=initial===undefined?undefined:numeric(initial);
  this.#last=this.#strategy==='delta'?number:undefined;this.#count=0;this.#initialized=number!==undefined;
  this.#value=this.#strategy==='delta'?0:number===undefined?0:initial!;
 }
 update(value:Json):void{
  if(this.#strategy==='basic'){if(this.#enabled(this.#exclude))this.#value=snapshot(value);return;}
  if(this.#strategy==='collect'){
   if(!this.#enabled(this.#exclude))return;
   const copy=snapshot(value),list=this.#value as Json[];
   const present=copy!==null&&typeof copy==='object'?list.some(item=>equal(item,copy)):
    list.includes(copy)||(typeof copy==='boolean'?list.includes(Number(copy)):copy===0||copy===1?list.includes(Boolean(copy)):false);
   if(present)return;
   const size=bytes(copy),evict=list.length>=100;
   const total=this.#collectionBytes+size+(list.length?1:0)-(evict?this.#sizes[0]+1:0);
   if(total>65536)throw new ApiError(413,'History collection byte limit exceeded');
   list.push(copy);this.#sizes.push(size);if(evict){list.shift();this.#sizes.shift();}this.#collectionBytes=total;return;
  }
  const number=numeric(value);if(number===undefined)return;
  finite(number);
  const enabled=this.#enabled(this.#exclude),old=numeric(this.#value)!;
  if(this.#strategy==='delta'){
   const next=enabled&&this.#last!==undefined?finite(old+(number-this.#last)):old;
   this.#value=next;this.#last=number;return;
  }
  if(!enabled)return;
  let next:Json;
  switch(this.#strategy){
   case 'accumulate':next=finite(old+number);break;
   case 'average':{
    const count=this.#count+1;if(!Number.isSafeInteger(count))throw new ApiError(422,'History sample count overflow');
    next=finite((old*(count-1)+number)/count);this.#count=count;break;
   }
   case 'maximum':next=this.#initialized&&old>=number?this.#value:value;break;
   case 'minimum':next=this.#initialized&&old<=number?this.#value:value;break;
  }
  this.#value=next;this.#initialized=true;
 }
}
