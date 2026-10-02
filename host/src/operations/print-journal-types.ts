import type { StartPrint } from './print.ts';
export type JournalState =
  'reserved' | 'started' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
export interface JournalRecord {
  request: Readonly<StartPrint>;
  state: JournalState;
  revision: number;
  statistics?:PrintStatistics;
  timestamps?:{reservedAt:number|null;startedAt:number|null;endedAt:number|null};
}
export interface JournalPage {records:JournalRecord[];nextAfter:string|null;}
export interface JournalHistoryRecord extends JournalRecord {historyId:string;}
export interface JournalHistoryEvent {action:'added'|'finished';record:JournalHistoryRecord;}
export interface JournalHistoryQuery {before?:number;since?:number;limit?:number;start?:number;order?:string;}
export interface PrintStatistics {totalDuration:number|null;printDuration:number|null;filamentUsed:number|null;}
export function printStatistics(value:unknown):PrintStatistics {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new JournalError('INVALID','Invalid print statistics');
  const v=value as PrintStatistics;
  if(Object.keys(v).length!==3||!['totalDuration','printDuration','filamentUsed'].every(key=>Object.hasOwn(v,key)))throw new JournalError('INVALID','Invalid print statistics fields');
  for(const key of ['totalDuration','printDuration','filamentUsed'] as const)if(v[key]!==null&&(typeof v[key]!=='number'||!Number.isFinite(v[key])||(key!=='filamentUsed'&&v[key]!<0)))throw new JournalError('INVALID','Invalid print statistics value');
  if(v.totalDuration!==null&&v.printDuration!==null&&v.printDuration>v.totalDuration)throw new JournalError('INVALID','Print duration exceeds total duration');
  return {totalDuration:v.totalDuration,printDuration:v.printDuration,filamentUsed:v.filamentUsed};
}
export interface JournalOptions {
  path: string;
  deviceId: string;
  maxRequests?: number;
  maxBytes?: number;
}
export class JournalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'JournalError';
    this.code = code;
  }
}
export function journalRequest(value: unknown): StartPrint {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new JournalError('INVALID', 'Invalid print request');
  const v = value as StartPrint;
  if (
    v.version !== 1 ||
    typeof v.requestId !== 'string' ||
    typeof v.fileId !== 'string' ||
    !validJournalId(v.requestId) ||
    !validJournalId(v.fileId) ||
    !Number.isFinite(v.nozzle) ||
    v.nozzle < 0 ||
    !Number.isFinite(v.bed) ||
    v.bed < 0 ||
    v.expiresAt !== undefined && (!Number.isSafeInteger(v.expiresAt) || v.expiresAt < 0)
  )
    throw new JournalError('INVALID', 'Invalid print request');
  return {
    version: 1,
    requestId: v.requestId,
    fileId: v.fileId,
    nozzle: v.nozzle,
    bed: v.bed,
    ...(v.expiresAt===undefined?{}:{expiresAt:v.expiresAt}),
  };
}
export function validJournalId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
export interface JournalInfo {
  sqlite: string;
  synchronous: number;
  lockingMode: string;
  journalMode: string;
  maxRequests: number;
  maxBytes: number;
}
