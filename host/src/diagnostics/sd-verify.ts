import {createHash} from 'node:crypto';
import {MessageDictionary} from '../protocol/dictionary.ts';
import {planSDFlash} from './sd-boards.ts';
import type {SDFileSystem} from './sd-filesystem.ts';
import {maximumFirmwareBytes} from '../build/firmware.ts';
/** Invoke on a newly connected MCU after reset/power cycling. A changed version
 * alone is not evidence that the requested firmware was installed. Dictionary
 * equality identifies the running build, not every byte in physical flash. */
export async function verifySDFirmware(files:Pick<SDFileSystem,'stat'|'readFile'>,current:MessageDictionary,request:{board:string;sha256:string;size:number;dictionary?:Uint8Array},signal:AbortSignal){
 signal.throwIfAborted();const actual=current.constant('MCU');if(typeof actual!=='string')throw new Error('Invalid firmware MCU identity');const plan=planSDFlash(request.board,actual);
 const {sha256,size}=request;if(!/^[a-f0-9]{64}$/.test(sha256)||!Number.isSafeInteger(size)||size<1||size>maximumFirmwareBytes)throw new Error('Invalid requested firmware fingerprint');
 if(request.dictionary!==undefined){
  const expectedBytes=request.dictionary;if(!(expectedBytes instanceof Uint8Array)||expectedBytes.buffer instanceof SharedArrayBuffer||!expectedBytes.length||expectedBytes.length>4*1024*1024)throw new Error('Invalid requested firmware dictionary');
  const expected=new MessageDictionary();expected.identify(expectedBytes,false);if(expected.constant('MCU')!==actual)throw new Error('Requested dictionary MCU mismatch');
  if(!Buffer.from(current.rawIdentify).equals(Buffer.from(expected.rawIdentify)))throw new Error('Running firmware dictionary mismatch');
  return {state:'verified' as const,evidence:'running-dictionary' as const,runningDictionaryMatched:true,bootloaderFileMatched:false,board:plan.name,dictionarySHA256:createHash('sha256').update(expected.rawIdentify).digest('hex')};
 }
 // Without a requested dictionary, report only the bootloader artifact proof.
 // Do not delete the upload or infer activation from an unrelated version change.
 const path=plan.currentFirmwarePath,info=await files.stat(path,signal);signal.throwIfAborted();if(info.size!==size)throw new Error('Bootloader firmware size mismatch');
 const bytes=await files.readFile(path,signal);signal.throwIfAborted();if(bytes.length!==size||createHash('sha256').update(bytes).digest('hex')!==sha256)throw new Error('Bootloader firmware SHA-256 mismatch');
 return {state:'verified' as const,evidence:'bootloader-file' as const,runningDictionaryMatched:false,bootloaderFileMatched:true,board:plan.name,path,size,sha256};
}
