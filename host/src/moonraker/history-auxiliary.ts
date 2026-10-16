// Shared Moonraker auxiliary capture; no database or worker initialization.
// Original Copyright (C) 2024 Eric Callahan. GPL-3.0-or-later.
import {ApiError,validateJson} from './rpc.ts';
import {boundedJsonBytes} from './json-size.ts';
import type {HistoryAuxiliarySnapshot,HistoryAuxiliaryUpdate} from './history-repository.ts';
export function validateHistoryAuxiliaryUpdates(input:HistoryAuxiliaryUpdate[]):void{
 if(!Array.isArray(input)||input.length>64)throw new ApiError(400,'Invalid auxiliary history fields');
 const seen=new Set<string>();
 for(const item of input){
  if(!item||typeof item!=='object')throw new ApiError(400,'Invalid auxiliary history update');
  const {provider,field}=item,precision=item.precision??null;
  if([provider,field].some(value=>typeof value!=='string'||!value||!value.isWellFormed()||Buffer.byteLength(value)>4096)||provider==='history'||typeof item.value!=='number'||!Number.isFinite(item.value)||typeof item.report_total!=='boolean'||typeof item.report_maximum!=='boolean'||!item.report_total&&!item.report_maximum||precision!==null&&!Number.isSafeInteger(precision))throw new ApiError(400,'Invalid auxiliary history update');
  const identity=JSON.stringify([provider,field]);if(seen.has(identity))throw new ApiError(400,'Duplicate auxiliary history field');seen.add(identity);
 }
}
/** Capture before provider updates/resets. Both durable histories use this. */
export function captureHistoryAuxiliary(input:HistoryAuxiliarySnapshot):{snapshot:HistoryAuxiliarySnapshot;bytes:number}{
 if(!input||!Array.isArray(input.data)||!Array.isArray(input.totals))throw new ApiError(400,'Invalid auxiliary history snapshot');
 validateHistoryAuxiliaryUpdates(input.totals);
 const result={data:input.data,totals:input.totals.map(field=>({...field,precision:field.precision??null}))};
 validateJson(result);const bytes=boundedJsonBytes(result,1024*1024);return {snapshot:structuredClone(result),bytes};
}
