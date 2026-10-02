// Offline SD flashing owner; callers must reserve/configure the SPI OID and
// own an exclusive maintenance session, never a live printing session.
import type {SerialSession} from '../protocol/serial-session.ts';
import {spiFormats} from '../protocol/spi-config.ts';
import {SDCardSPI} from './sd-card-spi.ts';
const owners=new WeakMap<SerialSession,Map<number,SDCardSPI>>();
export function sessionSDCardSPI(session:SerialSession,oid:number):SDCardSPI{
 session.assertActive();if(!Number.isInteger(oid)||oid<0||oid>254)throw new RangeError('Invalid SD SPI OID');
 let cards=owners.get(session);const existing=cards?.get(oid);if(existing)return existing;
 const dictionary=session.dictionary;for(const key of ['send','transfer','response'] as const)dictionary.lookup(spiFormats[key]);
 const queue=session.commandQueue();
 const checked=async<T>(signal:AbortSignal,work:()=>Promise<T>):Promise<T>=>{
  signal.throwIfAborted();session.assertActive();
  try{const result=await work();signal.throwIfAborted();session.assertActive();return result;}
  catch(error){try{await session.stop(error);}catch(stop){throw new AggregateError([error,stop],'SD SPI transaction and MCU stop failed',{cause:error});}throw error;}
 };
 const bytes=(data:Uint8Array)=>{if(!(data instanceof Uint8Array)||data.length<1||data.length>32)throw new RangeError('SD SPI packet must contain 1..32 bytes');return data.slice();};
 const card=new SDCardSPI({
  send(data,signal){const payload=dictionary.encode('spi_send',{oid,data:bytes(data)});return checked(signal,()=>queue.send(payload,0n,0n,signal));},
  transfer(data,signal){const snapshot=bytes(data),payload=dictionary.encode('spi_transfer',{oid,data:snapshot});return checked(signal,async()=>{
   // Reissuing SPI reads consumes additional card bytes; never retry at the
   // query layer. Serial framing still provides its normal ACK reliability.
   const response=await session.queryOnQueue(queue,payload,'spi_transfer_response',signal,{oid,retries:0,timeout:5}),value=response.message.parameters.response;
   if(response.message.name!=='spi_transfer_response'||response.message.parameters.oid!==oid||!(value instanceof Uint8Array)||value.length!==snapshot.length)throw new Error('Malformed SD SPI MCU response');
   return value.slice();
  });},
 });
 if(!cards){cards=new Map();owners.set(session,cards);}cards.set(oid,card);return card;
}
