import type {SerialSession} from '../protocol/serial-session.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import {TmcSpiChain} from './tmc-spi.ts';
export {spiFormats as tmcSpiFormats,softwareSpiFormats as tmcSoftwareSpiFormats,compileSpi as compileTmcSpi,compileSoftwareSpi as compileTmcSoftwareSpi} from '../protocol/spi-config.ts';
import {spiFormats as tmcSpiFormats} from '../protocol/spi-config.ts';
const owners=new WeakMap<SerialSession,Map<number,TmcSpiChain>>();
export function sessionTmcSpi(session:SerialSession,oid:number,length=1):TmcSpiChain{
 session.assertActive();if(!Number.isInteger(oid)||oid<0||oid>254||!Number.isInteger(length)||length<1||length>10)throw new RangeError('Invalid TMC SPI chain');
 let chains=owners.get(session);const existing=chains?.get(oid);if(existing){if(existing.length!==length)throw new Error('Inconsistent TMC SPI chain length');return existing;}
 const d=session.dictionary;for(const key of ['config','send','transfer','response'] as const)d.lookup(tmcSpiFormats[key]);const queue=session.commandQueue();
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
