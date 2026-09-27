import {createHash} from 'node:crypto';
import {FatFSError} from './fatfs.ts';
import type {SDFileSystem} from './sd-filesystem.ts';
import {prepareSDFirmware} from './sd-boards.ts';
const uploads=new WeakSet<object>();
/** Upload verification is not bootloader activation or running-firmware proof. */
export async function uploadSDFirmware(fs:Pick<SDFileSystem,'stat'|'writeFile'|'readFile'>,board:string,mcu:string,input:Uint8Array,signal:AbortSignal,options:{fast?:boolean;timestamp?:string}={}){
 signal.throwIfAborted();if(uploads.has(fs))throw new Error('SD firmware upload already active');uploads.add(fs);
 try{const prepared=prepareSDFirmware(board,mcu,input,options);
 if(prepared.plan.requiresUniqueName){let exists=true;try{await fs.stat(prepared.path,signal);}catch(error){if(error instanceof FatFSError&&error.code===4)exists=false;else throw error;}signal.throwIfAborted();if(exists)throw new Error('Unique firmware filename already exists');}
 await fs.writeFile(prepared.path,prepared.bytes,signal);signal.throwIfAborted();const info=await fs.stat(prepared.path,signal);signal.throwIfAborted();if(info.size!==prepared.size)throw new Error('Uploaded firmware size mismatch');
 const readback=await fs.readFile(prepared.path,signal);signal.throwIfAborted();if(readback.length!==prepared.size||createHash('sha256').update(readback).digest('hex')!==prepared.sha256)throw new Error('Uploaded firmware SHA-256 mismatch');
 return {state:'uploaded' as const,activationVerified:false as const,board:prepared.plan.name,path:prepared.path,size:prepared.size,sha256:prepared.sha256,requiresPowerCycle:prepared.plan.requiresPowerCycle,currentFirmwarePath:prepared.plan.currentFirmwarePath};
 }finally{uploads.delete(fs);}
}
