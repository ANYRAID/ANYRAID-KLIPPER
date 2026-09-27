import {maximumFirmwareBytes} from '../build/firmware.ts';
import {MessageDictionary} from '../protocol/dictionary.ts';
import type {SerialSession} from '../protocol/serial-session.ts';
import {sdBoardDefinition,prepareSDFirmware} from './sd-boards.ts';
import {openSDFlashMachine} from './sd-flash-machine.ts';
import {uploadSDFirmware} from './sd-upload.ts';
import {verifySDFirmware} from './sd-verify.ts';
export interface SDFlashConnection {
 /** Each call must return a newly initialized, exclusively owned offline UART.
  * reconnect=true additionally waits for the same device to reboot. */
 connect(signal:AbortSignal,reconnect:boolean):Promise<SerialSession>;
}
export interface SDFlashRequest {board:string;firmware:Uint8Array;dictionary?:Uint8Array;verifyOnly?:boolean;fast?:boolean;timestamp?:string;helper?:string;}
const owners=new WeakSet<SDFlashConnection>();
/** One upload only. Reset/reconnect never retries a firmware write. The caller
 * must have stopped the printer host before giving this operation the UART. */
export async function flashSDCard(io:SDFlashConnection,request:SDFlashRequest,signal:AbortSignal){
 signal.throwIfAborted();if(owners.has(io))throw new Error('SD flash operation already active');
 for(const value of [request.fast,request.verifyOnly])if(value!==undefined&&typeof value!=='boolean')throw new TypeError('Invalid SD flash option');
 if(!(request.firmware instanceof Uint8Array)||request.firmware.buffer instanceof SharedArrayBuffer||!request.firmware.length||request.firmware.length>maximumFirmwareBytes)throw new Error('Invalid SD firmware image');
 if(request.dictionary!==undefined&&(!(request.dictionary instanceof Uint8Array)||request.dictionary.buffer instanceof SharedArrayBuffer||!request.dictionary.length||request.dictionary.length>4*1024*1024))throw new Error('Invalid requested firmware dictionary');
 const board=sdBoardDefinition(request.board),snapshot={...request,firmware:Uint8Array.from(request.firmware),dictionary:request.dictionary===undefined?undefined:Uint8Array.from(request.dictionary)};
 const prepared=prepareSDFirmware(snapshot.board,board.mcu,snapshot.firmware,{fast:snapshot.fast,timestamp:snapshot.timestamp});
 if(snapshot.dictionary!==undefined){const expected=new MessageDictionary();expected.identify(snapshot.dictionary,false);if(expected.constant('MCU')!==board.mcu)throw new Error('Requested dictionary MCU mismatch');}
 owners.add(io);let session:SerialSession|undefined,machine:Awaited<ReturnType<typeof openSDFlashMachine>>|undefined;
 const release=async()=>{const errors:unknown[]=[];try{await machine?.close();}catch(error){errors.push(error);}machine=undefined;try{await session?.stop();}catch(error){errors.push(error);}session=undefined;if(errors.length)throw new AggregateError(errors,'SD flash cleanup failed');};
 const connect=async(reconnect:boolean)=>{
  session=await io.connect(signal,reconnect);signal.throwIfAborted();
  if(session.dictionary.constant('MCU')!==board.mcu)throw new Error('SD flash board MCU mismatch');
  const response=await session.query(session.dictionary.encode('get_config',{}),'config',signal,{retries:0});signal.throwIfAborted();const p=response.message.parameters;
  if(response.message.name!=='config'||![0,1].includes(p.is_config as number)||![0,1].includes(p.is_shutdown as number))throw new Error('Invalid MCU configuration status');
  if(p.is_shutdown)throw new Error('MCU is shutdown before SD flashing');
  if(p.is_config){await session.resetOffline(signal);await release();session=await io.connect(signal,true);signal.throwIfAborted();}
  machine=await openSDFlashMachine(session,snapshot.board,signal,{fast:snapshot.fast,helper:snapshot.helper});
 };
 try{
  await connect(false);let upload:Awaited<ReturnType<typeof uploadSDFirmware>>|undefined;
  if(!snapshot.verifyOnly){
   upload=await uploadSDFirmware(machine!.files,snapshot.board,board.mcu,snapshot.firmware,signal,{fast:snapshot.fast,timestamp:snapshot.timestamp});
   if(prepared.plan.requiresPowerCycle){await release();return {state:'power-cycle-required' as const,upload};}
   await machine!.reset(signal);await release();await connect(true);
  }
  const verification=await verifySDFirmware(machine!.files,session!.dictionary,{board:snapshot.board,sha256:prepared.sha256,size:prepared.size,dictionary:snapshot.dictionary},signal);
  await machine!.reset(signal);await release();return {state:'verified' as const,upload,verification};
 }catch(error){try{await release();}catch(cleanup){throw new AggregateError([error,cleanup],'SD flashing and cleanup failed',{cause:error});}throw error;}
 finally{owners.delete(io);}
}
