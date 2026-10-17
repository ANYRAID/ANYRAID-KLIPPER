// Durable service progress is evidence only. Reopening never dispatches it.
import type {Json} from './rpc.ts';
import type {MachineAction,MachineRetirement} from './machine-control.ts';
export interface ManagedServiceEntry {aliases:string[];action:MachineAction;retirement:MachineRetirement;state:'planned'|'queued'|'succeeded'|'failed'|'interrupted';request_id:string|null;}
export interface ManagedServiceProgress {schema:1;state:'running'|'awaiting_response'|'failed'|'interrupted'|'complete';next:number;entries:ManagedServiceEntry[];}
export function managedServiceProgress(value:unknown):value is ManagedServiceProgress {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const row=value as ManagedServiceProgress;
 return row.schema===1&&['running','awaiting_response','failed','interrupted','complete'].includes(row.state)&&Number.isSafeInteger(row.next)&&Array.isArray(row.entries)&&row.entries.length<=3&&row.next>=0&&row.next<=row.entries.length&&row.entries.every(entry=>entry&&typeof entry==='object'&&Array.isArray(entry.aliases)&&entry.aliases.length>=1&&entry.aliases.length<=3&&entry.aliases.every(name=>typeof name==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(name))&&['none','device','process'].includes(entry.retirement)&&['planned','queued','succeeded','failed','interrupted'].includes(entry.state)&&(entry.request_id===null||typeof entry.request_id==='string'&&/^machine-[a-f0-9-]{36}$/u.test(entry.request_id))&&entry.action&&typeof entry.action==='object'&&(entry.action.kind==='server_restart'&&Object.keys(entry.action).length===1||entry.action.kind==='service'&&Object.keys(entry.action).length===3&&entry.action.action==='restart'&&typeof entry.action.service==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(entry.action.service)));
}
export const serviceProgressJson=(value:ManagedServiceProgress)=>structuredClone(value) as unknown as Json;
