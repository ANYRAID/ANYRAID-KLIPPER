// Moonraker HistoryFieldData semantics. GPL-3.0-or-later.
// Original Copyright (C) 2023 Eric Callahan.
import {HistoryTracker,historyStrategies,type HistoryNumberType,type HistoryStrategy} from './history-tracker.ts';
import {roundHistoryDecimal} from './history-round.ts';
import type {HistoryAuxiliarySnapshot,HistoryAuxiliaryUpdate} from './history-repository.ts';
import {ApiError,type Json} from './rpc.ts';
export interface HistoryFieldOptions {
 name:string;provider:string;description:string;strategy:HistoryStrategy|string;
 units?:string|null;precision?:number|null;reset?:()=>Json;excludePaused?:boolean;
 reportTotal?:boolean;reportMaximum?:boolean;numberType?:HistoryNumberType;
}
function text(value:string,empty=false):string{if(typeof value!=='string'||!value.isWellFormed()||!empty&&!value||Buffer.byteLength(value)>4096)throw new ApiError(400,'Invalid history field text');return value;}
export class HistoryField {
 readonly tracker:HistoryTracker;readonly #config:{field:string;provider:string;description:string;strategy:HistoryStrategy;units:string|null;report_total:boolean;report_maximum:boolean;precision:number|null};
 constructor(options:HistoryFieldOptions,trackingEnabled:(excludePaused:boolean)=>boolean){
  const strategy=typeof options.strategy==='string'?options.strategy.toLowerCase() as HistoryStrategy:undefined;
  if(!strategy||!historyStrategies.includes(strategy)||options.precision!==undefined&&options.precision!==null&&!Number.isSafeInteger(options.precision)||options.reportTotal!==undefined&&typeof options.reportTotal!=='boolean'||options.reportMaximum!==undefined&&typeof options.reportMaximum!=='boolean')throw new ApiError(400,'Invalid history field options');
  this.#config={field:text(options.name),provider:text(options.provider),description:text(options.description,true),strategy,units:options.units==null?null:text(options.units,true),report_total:options.reportTotal??false,report_maximum:options.reportMaximum??false,precision:options.precision??null};
  if(this.#config.provider==='history')throw new ApiError(400,"Provider name 'history' is reserved");
  this.tracker=new HistoryTracker({strategy,trackingEnabled,reset:options.reset,excludePaused:options.excludePaused,numberType:options.numberType});
 }
 get configuration(){return {...this.#config,init_tracker:this.tracker.hasResetCallback,exclude_paused:this.tracker.excludePaused};}
 snapshot():{data:Record<string,Json>;total?:HistoryAuxiliaryUpdate}{
  const c=this.#config,raw=this.tracker.value,value=this.tracker.isFloat&&typeof raw==='number'?roundHistoryDecimal(raw,c.precision):raw;
  const data={provider:c.provider,name:c.field,value,description:c.description,units:c.units};
  if(!this.tracker.hasTotals||!c.report_total&&!c.report_maximum)return {data};
  return {data,total:{provider:c.provider,field:c.field,value:typeof raw==='boolean'?Number(raw):raw as number,report_total:c.report_total,report_maximum:c.report_maximum,precision:c.precision}};
 }
}
/** One registry per HistoryRuntime. Register providers in its auxiliary factory;
 * snapshots feed the existing ingress capture and atomic persistence path. */
export class HistoryFields {
 readonly #fields=new Map<string,HistoryField>();readonly #enabled:(excludePaused:boolean)=>boolean;
 constructor(trackingEnabled:(excludePaused:boolean)=>boolean){if(typeof trackingEnabled!=='function')throw new ApiError(400,'Invalid history tracking gate');this.#enabled=trackingEnabled;}
 register(options:HistoryFieldOptions):HistoryField{
  return this.registerBatch([options])[0];
 }
 registerBatch(options:readonly HistoryFieldOptions[]):HistoryField[]{
  if(!Array.isArray(options)||this.#fields.size+options.length>64)throw new ApiError(413,'History field capacity exceeded');
  const keys=new Set(this.#fields.keys()),pending=options.map(option=>{const field=new HistoryField(option,this.#enabled),c=field.configuration,key=JSON.stringify([c.provider,c.field]);if(keys.has(key))throw new ApiError(409,'History field already registered');keys.add(key);return {key,field};});
  for(const {key,field} of pending)this.#fields.set(key,field);return pending.map(item=>item.field);
 }
 get configuration(){return [...this.#fields.values()].map(field=>field.configuration);}
 reset():void{for(const field of this.#fields.values())field.tracker.reset();}
 snapshot():HistoryAuxiliarySnapshot{
  const data:Json[]=[],totals:HistoryAuxiliaryUpdate[]=[];for(const field of this.#fields.values()){const value=field.snapshot();data.push(value.data);if(value.total)totals.push(value.total);}return {data,totals};
 }
}
