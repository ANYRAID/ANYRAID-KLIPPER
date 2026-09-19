// Configuration CRC and handshake derived from klippy/mcu.py (GPL-3.0-or-later).
import {crc32} from 'node:zlib';
import {MessageDictionary} from './dictionary.ts';
import type {TimedResponse} from './clock-transport.ts';
export interface MCUConfigPlan {oidCount:number;commands:readonly string[];restart?:readonly string[];init?:readonly string[];reservedMoves?:number;firmwareRestart?:boolean}
export interface MCUConfigTransport {
 query(payload:Uint8Array,name:string,signal:AbortSignal):Promise<TimedResponse>;
 send(payload:Uint8Array,signal:AbortSignal):Promise<void>;
 stop(cause:unknown):Promise<void>;
}
export interface ConfiguredMCU {crc:number;moveCount:number;moveSlots:number;reused:boolean}
function uint(value:unknown,max:number):number{if(typeof value!=='number'||!Number.isInteger(value)||value<0||value>max)throw new Error('Malformed MCU configuration response');return value;}
/** Caller resolves and reserves pins before constructing the textual plan.
 * No automatic reset on mismatch: configuration commands must never be replayed. */
export async function configureMCU(dictionary:MessageDictionary,transport:MCUConfigTransport,plan:MCUConfigPlan,signal:AbortSignal):Promise<ConfiguredMCU>{
 try{
  signal.throwIfAborted();const reserved=plan.reservedMoves??0,firmwareRestart=!!plan.firmwareRestart;
  if(!Number.isInteger(plan.oidCount)||plan.oidCount<0||plan.oidCount>255||!Number.isInteger(reserved)||reserved<0||reserved>65535)throw new RangeError('Invalid MCU configuration limits');
  const commands=[`allocate_oids count=${plan.oidCount}`,...plan.commands],restart=[...(plan.restart??[])],init=[...(plan.init??[])];
  if(commands.length+restart.length+init.length>10000)throw new RangeError('Too many MCU configuration commands');
  let bytes=0;for(const command of [...commands,...restart,...init]){if(typeof command!=='string'||!command.trim()||/[\r\n\0]/.test(command)||command.length>4096)throw new Error('Invalid MCU configuration command');bytes+=Buffer.byteLength(command);if(bytes>1024*1024)throw new RangeError('MCU configuration text exceeds budget');}
  // CRC covers exactly the resolved config text, excluding finalization and init.
  const crc=crc32(Buffer.from(commands.join('\n'))),full=[...commands,`finalize_config crc=${crc}`];
  const encoded=full.map(c=>dictionary.encodeCommand(c)),encodedRestart=restart.map(c=>dictionary.encodeCommand(c)),encodedInit=init.map(c=>dictionary.encodeCommand(c));
  const request=dictionary.encode('get_config',{});
  const read=async()=>{signal.throwIfAborted();const response=await transport.query(request.slice(),'config',signal);signal.throwIfAborted();if(response.message.name!=='config')throw new Error('Unexpected MCU configuration response');const p=response.message.parameters;
   const result={configured:uint(p.is_config,1),crc:uint(p.crc,0xffffffff),shutdown:uint(p.is_shutdown,1),moveCount:uint(p.move_count,65535)};if(result.shutdown)throw new Error('MCU is shutdown during configuration');return result;};
  const before=await read();
  if(before.configured&&firmwareRestart)throw new Error('MCU firmware restart did not clear configuration');
  if(before.configured&&before.crc!==crc)throw new Error('MCU configuration CRC mismatch; reset required');
  for(const payload of [...(before.configured?encodedRestart:encoded),...encodedInit]){signal.throwIfAborted();await transport.send(payload.slice(),signal);}
  const after=await read();if(!after.configured||after.crc!==crc)throw new Error('MCU did not finalize expected configuration');
  if(after.moveCount<reserved)throw new Error('Too few MCU move slots for reservations');
  return Object.freeze({crc,moveCount:after.moveCount,moveSlots:after.moveCount-reserved,reused:!!before.configured});
 }catch(error){try{await transport.stop(error);}catch(stopError){throw new AggregateError([error,stopError],'MCU configuration and stop failed');}throw error;}
}
