import {createRequire} from 'node:module';
import {open,type FileHandle} from 'node:fs/promises';
import {closeSync} from 'node:fs';
import type {PrintSnapshotBudget} from '../gcode/snapshot-budget.ts';
const native=createRequire(import.meta.url)(process.env.ANYRAID_SEALED_FILE_ADDON??'../../build/sealed-file.node') as {create():number;seal(fd:number):void};
/** A bounded staging source; the owner supplies a separate snapshot quota. */
export async function sealedBuffer(bytes:Buffer,signal:AbortSignal,budget:PrintSnapshotBudget):Promise<{file:FileHandle;close:()=>Promise<void>}>{
 signal.throwIfAborted();const lease=budget.reserve(bytes.length);let file:FileHandle|undefined;
 try{const fd=native.create();try{file=await open(`/proc/self/fd/${fd}`,'r+');}finally{closeSync(fd);}
  let position=0;while(position<bytes.length){signal.throwIfAborted();const {bytesWritten}=await file.write(bytes,position,Math.min(65536,bytes.length-position),position);if(!bytesWritten)throw new Error('Sealed buffer write stalled');position+=bytesWritten;}
  signal.throwIfAborted();native.seal(file.fd);let closing:Promise<void>|undefined;const owned=file;
  return {file:owned,close:()=>closing??(closing=owned.close().then(()=>lease.release()))};
 }catch(error){try{await file?.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Sealed buffer cleanup failed; quota retained',{cause:error});}lease.release();throw error;}
}
