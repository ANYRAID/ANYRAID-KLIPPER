import type { StartPrint } from './print.ts';
export type JournalState =
  'reserved' | 'started' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
export interface JournalRecord {
  request: Readonly<StartPrint>;
  state: JournalState;
  revision: number;
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
    v.bed < 0
  )
    throw new JournalError('INVALID', 'Invalid print request');
  return {
    version: 1,
    requestId: v.requestId,
    fileId: v.fileId,
    nozzle: v.nozzle,
    bed: v.bed,
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
