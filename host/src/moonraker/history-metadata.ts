import {ApiError,validateJson,type Json} from './rpc.ts';
import {boundedJsonBytes} from './json-size.ts';
export interface HistoryMetadataSnapshot {generation:string;fields:Readonly<Record<string,Json>>;}
export type HistoryMetadataProvider=(filename:string)=>HistoryMetadataSnapshot|undefined;
/** Discard transient payloads before copying; never mutate the scanner's snapshot. */
export function captureHistoryMetadata(snapshot:HistoryMetadataSnapshot):{snapshot:HistoryMetadataSnapshot;bytes:number}{
 if(!snapshot||typeof snapshot.generation!=='string'||!snapshot.generation||!snapshot.generation.isWellFormed()||Buffer.byteLength(snapshot.generation)>256||!snapshot.fields||typeof snapshot.fields!=='object'||Array.isArray(snapshot.fields)||![Object.prototype,null].includes(Object.getPrototypeOf(snapshot.fields)))throw new ApiError(502,'Invalid history metadata snapshot');
 const kept=Object.fromEntries(Object.entries(snapshot.fields).filter(([key])=>!['print_start_time','job_id'].includes(key)).map(([key,value])=>{
  if(key!=='thumbnails')return [key,value];
  if(!Array.isArray(value)||value.length>256)throw new ApiError(502,'Invalid history thumbnails');
  return [key,value.map(item=>{
   if(!item||typeof item!=='object'||Array.isArray(item)||![Object.prototype,null].includes(Object.getPrototypeOf(item)))throw new ApiError(502,'Invalid history thumbnail');
   return Object.fromEntries(Object.entries(item).filter(([name])=>name!=='data'));
  })];
 }));
 validateJson(kept);const bytes=boundedJsonBytes({generation:snapshot.generation,fields:kept},1024*1024),fields=structuredClone(kept);
 return {snapshot:{generation:snapshot.generation,fields},bytes};
}
