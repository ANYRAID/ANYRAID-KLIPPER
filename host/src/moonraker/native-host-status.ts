import {ApiError} from './rpc.ts';
import type {PrintState} from '../operations/print.ts';
export interface NativeHostSnapshot {
 group_state:'idle'|'connecting'|'ready'|'stopping'|'stopped'|'failed';
 hardware_state:'starting'|'ready'|'stopping'|'stopped'|'failed';
 print_state:PrintState;homed_axes:string;closing:boolean;admission_closed:boolean;maintenance:boolean;
 mcus:readonly {id:string;state:'new'|'identifying'|'warming'|'ready'|'closed'|'unavailable'}[];
}
export type NativeHostStatusSource=()=>NativeHostSnapshot;
const groups=new Set(['idle','connecting','ready','stopping','stopped','failed']),hardware=new Set(['starting','ready','stopping','stopped','failed']),sessions=new Set(['new','identifying','warming','ready','closed','unavailable']);
const prints:Record<PrintState,true>={idle:true,interrupted:true,preparing:true,printing:true,pausing:true,paused:true,resuming:true,finishing:true,completed:true,cancelling:true,cancelled:true,failed:true};
/** One synchronous read, bounded DTO, no error messages, serial paths or job
 * identities. Never retain a last-good ready result when the source fails. */
export function readNativeHostStatus(source:NativeHostStatusSource){
 try{
  const v=source();
  if(v&&typeof (v as any).then==='function'){void Promise.resolve(v).catch(()=>{});throw new Error('Asynchronous status source');}
  if(!v||!groups.has(v.group_state)||!hardware.has(v.hardware_state)||typeof v.print_state!=='string'||!Object.hasOwn(prints,v.print_state)||typeof v.homed_axes!=='string'||!/^[xyz]{0,3}$/.test(v.homed_axes)||new Set(v.homed_axes).size!==v.homed_axes.length||[v.closing,v.admission_closed,v.maintenance].some(b=>typeof b!=='boolean')||!Array.isArray(v.mcus)||!v.mcus.length||v.mcus.length>16)throw new Error('Invalid native status');
  const ids=new Set<string>(),mcus=v.mcus.map(m=>{if(!m||typeof m.id!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(m.id)||ids.has(m.id)||!sessions.has(m.state))throw new Error('Invalid native MCU status');ids.add(m.id);return {id:m.id,state:m.state};});
  return {version:1,ready:!v.closing&&!v.admission_closed&&v.group_state==='ready'&&v.hardware_state==='ready'&&mcus.every(m=>m.state==='ready'),group_state:v.group_state,hardware_state:v.hardware_state,print_state:v.print_state,homed_axes:v.homed_axes,closing:v.closing,admission_closed:v.admission_closed,maintenance:v.maintenance,mcus};
 }catch{throw new ApiError(503,'Native host status is unavailable');}
}
