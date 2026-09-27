import type {MessageDictionary} from '../protocol/dictionary.ts';
import type {PinBinding} from '../protocol/pins.ts';
import type {SerialSession} from '../protocol/serial-session.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import {TmcSpiChain} from './tmc-spi.ts';
export const tmcSpiFormats={config:'config_spi oid=%c pin=%u cs_active_high=%c',bus:'spi_set_bus oid=%c spi_bus=%u mode=%u rate=%u',send:'spi_send oid=%c data=%*s',transfer:'spi_transfer oid=%c data=%*s',response:'spi_transfer_response oid=%c response=%*s'} as const;
/** Caller owns GPIO reservation and must configure ALL chip selects before
 * applying bus commands. Explicit bus selection avoids silently choosing pins. */
export function compileTmcSpi<T>(chip:T,d:MessageDictionary,oid:number,cs:PinBinding<T>,bus:string|number,rate=4000000){
 if(!Number.isInteger(oid)||oid<0||oid>254||cs.chip!==chip||!cs.pin||/[\s^~!:]/u.test(cs.pin)||cs.invert!==0||cs.pullup!==0||!Number.isInteger(rate)||rate<100000||rate>0xffffffff||typeof bus==='number'&&(!Number.isInteger(bus)||bus<0||bus>0xffffffff)||typeof bus==='string'&&(!bus||/[\s=]/u.test(bus)))throw new Error('Invalid TMC SPI configuration');
 for(const format of Object.values(tmcSpiFormats))d.lookup(format);
 const select=`config_spi oid=${oid} pin=${cs.pin} cs_active_high=0`,configureBus=`spi_set_bus oid=${oid} spi_bus=${bus} mode=3 rate=${rate}`;d.encodeCommand(select);d.encodeCommand(configureBus);
 return Object.freeze({oid,rate,select,configureBus});
}
const owners=new WeakMap<SerialSession,Map<number,TmcSpiChain>>();
export function sessionTmcSpi(session:SerialSession,oid:number,length=1):TmcSpiChain{
 session.assertActive();if(!Number.isInteger(oid)||oid<0||oid>254||!Number.isInteger(length)||length<1||length>10)throw new RangeError('Invalid TMC SPI chain');
 let chains=owners.get(session);const existing=chains?.get(oid);if(existing){if(existing.length!==length)throw new Error('Inconsistent TMC SPI chain length');return existing;}
 const d=session.dictionary;for(const format of Object.values(tmcSpiFormats))d.lookup(format);const queue=session.commandQueue();
 const chain=new TmcSpiChain({async transfer(preface,data,minClock,signal){
  session.assertActive();const send=d.encode('spi_send',{oid,data:preface}),query=d.encode('spi_transfer',{oid,data});
  try{
   const now=serialClock.now(),release=minClock===0n?now:session.clock.sync.systemTime(minClock),timeout=Math.max(5,release-now+5);
   if(!Number.isFinite(timeout)||timeout>60)throw new RangeError('TMC SPI query exceeds scheduling horizon');
   // Firmware SPI commands are synchronous. The shared FIFO preserves the
   // preface/query order even when other peripheral queues are active.
   // Common short chains fit one MCU packet: avoid an extra host ACK round trip.
   let payload:Uint8Array=query;if(send.length+query.length<=59)payload=Buffer.concat([send,query]);else await queue.send(send,minClock,minClock,signal);
   const response=await session.queryOnQueue(queue,payload,'spi_transfer_response',signal,{oid,retries:0,timeout,minClock,reqClock:minClock}),bytes=response.message.parameters.response;
   if(response.message.name!=='spi_transfer_response'||response.message.parameters.oid!==oid||!(bytes instanceof Uint8Array)||bytes.length!==data.length)throw new Error('Malformed TMC SPI MCU response');return bytes.slice();
  }catch(error){try{await session.stop(error);}catch(stop){throw new AggregateError([error,stop],'TMC SPI transaction and MCU stop failed',{cause:error});}throw error;}
 }},length);
 if(!chains){chains=new Map();owners.set(session,chains);}chains.set(oid,chain);return chain;
}
