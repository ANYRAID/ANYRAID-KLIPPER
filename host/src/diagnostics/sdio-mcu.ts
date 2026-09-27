// SDIO firmware protocol from src/sdiocmds.c, GPL-3.0-or-later.
import type {SerialSession} from '../protocol/serial-session.ts';
import type {MessageDictionary} from '../protocol/dictionary.ts';
export const sdioFormats={
 config:'config_sdio oid=%c blocksize=%u',bus:'sdio_set_bus oid=%c sdio_bus=%u',speed:'sdio_set_speed oid=%c speed=%u',
 command:'sdio_send_command oid=%c cmd=%c argument=%u wait=%c',commandResponse:'sdio_send_command_response oid=%c error=%c response=%*s',
 read:'sdio_read_data oid=%c cmd=%c argument=%u',readResponse:'sdio_read_data_response oid=%c error=%c read=%u',
 write:'sdio_write_data oid=%c cmd=%c argument=%u',writeResponse:'sdio_write_data_response oid=%c error=%c write=%u',
 readBuffer:'sdio_read_data_buffer oid=%c offset=%u len=%c',bufferResponse:'sdio_read_data_buffer_response oid=%c data=%*s',writeBuffer:'sdio_write_data_buffer oid=%c offset=%u data=%*s',
} as const;
function integer(value:number,maximum:number,name:string){if(!Number.isInteger(value)||value<0||value>maximum)throw new RangeError('Invalid SDIO '+name);}
export function compileSDIO(dictionary:MessageDictionary,oid:number,bus:string){
 integer(oid,254,'OID');if(typeof bus!=='string'||!bus||/[\s=]/u.test(bus))throw new TypeError('Invalid SDIO bus');for(const format of Object.values(sdioFormats))dictionary.lookup(format);
 const config=`config_sdio oid=${oid} blocksize=512`,configureBus=`sdio_set_bus oid=${oid} sdio_bus=${bus}`;dictionary.encodeCommand(config);dictionary.encodeCommand(configureBus);return Object.freeze({oid,config,configureBus});
}
export interface SDIOTransport {
 command(command:number,argument:number,wait:0|1|2,signal:AbortSignal):Promise<{error:number;response:Uint8Array}>;
 readSector(address:number,signal:AbortSignal):Promise<Uint8Array>;
 writeSector(address:number,data:Uint8Array,signal:AbortSignal):Promise<void>;
 speed(hz:number,signal:AbortSignal):Promise<void>;
}
const owners=new WeakMap<SerialSession,Map<number,SDIOTransport>>();
/** Owns the shared firmware sector buffer for each OID. The complete buffer
 * transfer and its command are serialized, not just individual MCU messages.
 * Caller must configure an exclusively owned offline SDIO device first. */
export function sessionSDIO(session:SerialSession,oid:number):SDIOTransport{
 session.assertActive();integer(oid,254,'OID');let devices=owners.get(session);const existing=devices?.get(oid);if(existing)return existing;
 const d=session.dictionary;for(const format of Object.values(sdioFormats))d.lookup(format);const queue=session.commandQueue();let tail:Promise<unknown>=Promise.resolve(),pending=0;
 function operation<T>(signal:AbortSignal,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  if(pending>=8)return Promise.reject(new Error('SDIO operation queue full'));pending++;const bounded=AbortSignal.any([signal,AbortSignal.timeout(30000)]);
  const task=tail.then(async()=>{bounded.throwIfAborted();session.assertActive();try{const value=await work(bounded);bounded.throwIfAborted();session.assertActive();return value;}catch(error){try{await session.stop(error);}catch(stop){throw new AggregateError([error,stop],'SDIO operation and MCU stop failed',{cause:error});}throw error;}});
  tail=task.catch(()=>{});return task.finally(()=>{pending--;});
 }
 async function query(name:string,parameters:Record<string,number>,responseName:string,signal:AbortSignal){
  signal.throwIfAborted();const r=await session.queryOnQueue(queue,d.encode(name,{oid,...parameters}),responseName,signal,{oid,retries:0,timeout:5});signal.throwIfAborted();
  if(r.message.name!==responseName||r.message.parameters.oid!==oid)throw new Error('Malformed SDIO response route');return r.message.parameters;
 }
 function result(error:unknown){if(typeof error!=='number'||!Number.isInteger(error)||error<0||error>255)throw new Error('Malformed SDIO error code');return error;}
 const device:SDIOTransport={
  command(command,argument,wait,signal){integer(command,63,'command');integer(argument,0xffffffff,'argument');integer(wait,2,'wait');return operation(signal,async s=>{
   const r=await query('sdio_send_command',{cmd:command,argument,wait},'sdio_send_command_response',s),error=result(r.error),response=r.response;
   if(!(response instanceof Uint8Array)||response.length>(wait===2?16:wait===1?4:0)||error===0&&response.length!==(wait===2?16:wait===1?4:0))throw new Error('Malformed SDIO command response');
   // Card initialization must interpret errors (e.g. CMD8 unsupported or R3
   // without CRC) explicitly. Sector IO always treats nonzero errors as fatal.
   return {error,response:response.slice()};
  });},
  readSector(address,signal){integer(address,0xffffffff,'address');return operation(signal,async s=>{
   const r=await query('sdio_read_data',{cmd:17,argument:address},'sdio_read_data_response',s);if(result(r.error)!==0||r.read!==512)throw new Error('SDIO sector read failed');
   const bytes=new Uint8Array(512);for(let offset=0;offset<512;offset+=32){const part=await query('sdio_read_data_buffer',{offset,len:32},'sdio_read_data_buffer_response',s),data=part.data;if(!(data instanceof Uint8Array)||data.length!==32)throw new Error('Malformed SDIO sector buffer');bytes.set(data,offset);}return bytes;
  });},
  writeSector(address,data,signal){integer(address,0xffffffff,'address');if(!(data instanceof Uint8Array)||data.length!==512)throw new RangeError('SDIO requires one 512-byte sector');const bytes=data.slice();return operation(signal,async s=>{
   for(let offset=0;offset<512;offset+=32){s.throwIfAborted();await queue.send(d.encode('sdio_write_data_buffer',{oid,offset,data:bytes.subarray(offset,offset+32)}),0n,0n,s);}
   const r=await query('sdio_write_data',{cmd:24,argument:address},'sdio_write_data_response',s);if(result(r.error)!==0||r.write!==512)throw new Error('SDIO sector write failed');
  });},
  speed(hz,signal){integer(hz,1000000,'speed');if(hz<100000)throw new RangeError('Invalid SDIO speed');return operation(signal,s=>queue.send(d.encode('sdio_set_speed',{oid,speed:hz}),0n,0n,s));},
 };
 if(!devices){devices=new Map();owners.set(session,devices);}devices.set(oid,device);return device;
}
