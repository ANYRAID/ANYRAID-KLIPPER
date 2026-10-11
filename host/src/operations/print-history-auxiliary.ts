import {captureHistoryAuxiliary} from '../moonraker/history-auxiliary.ts';
import {encodeDatabaseRecord,decodeDatabaseRecord} from '../moonraker/database-record.ts';
import {JournalError} from './print-journal-types.ts';
import type {HistoryAuxiliarySnapshot} from '../moonraker/history-repository.ts';
export function captureJournalAuxiliary(value:HistoryAuxiliarySnapshot):HistoryAuxiliarySnapshot{
 try{return captureHistoryAuxiliary(value).snapshot;}
 catch(error){throw new JournalError((error as {status?:number}).status===413?'CAPACITY':'INVALID','Invalid or oversized print history auxiliary snapshot');}
}
export function encodeJournalAuxiliary(value:HistoryAuxiliarySnapshot):Buffer{
 const snapshot=captureJournalAuxiliary(value),bytes=encodeDatabaseRecord(snapshot as unknown as import('../moonraker/rpc.ts').Json);
 if(bytes.length>1024*1024)throw new JournalError('CAPACITY','Print history auxiliary snapshot exceeds byte limit');return bytes;
}
export function decodeJournalAuxiliary(value:unknown):HistoryAuxiliarySnapshot{
 try{
  if(!(value instanceof Uint8Array)||value.length>1024*1024)throw Error();
  const snapshot=captureJournalAuxiliary(decodeDatabaseRecord(value) as unknown as HistoryAuxiliarySnapshot);
  if(!encodeJournalAuxiliary(snapshot).equals(Buffer.from(value)))throw Error();return snapshot;
 }catch{throw new JournalError('CORRUPT','Invalid persisted print history auxiliary snapshot');}
}
