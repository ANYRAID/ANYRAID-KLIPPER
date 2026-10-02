// MCU bit-banged TMC UART protocol. GPL-3.0-or-later.
import type {MessageDictionary} from '../protocol/dictionary.ts';
import type {PinBinding} from '../protocol/pins.ts';
import type {SerialSession} from '../protocol/serial-session.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import {TmcUartBus} from './tmc-uart.ts';
export const tmcUartFormats={config:'config_tmcuart oid=%c rx_pin=%u pull_up=%c tx_pin=%u bit_time=%u',send:'tmcuart_send oid=%c write=%*s read=%c',response:'tmcuart_response oid=%c read=%*s'} as const;
/** Validates the complete firmware command before the caller publishes OIDs. */
export function compileTmcUart<T>(chip:T,d:MessageDictionary,oid:number,rx:PinBinding<T>,tx:PinBinding<T>){
 if(!Number.isInteger(oid)||oid<0||oid>254||[rx,tx].some(p=>p.chip!==chip||!p.pin||/[\s^~!:]/u.test(p.pin)||p.invert!==0)||![0,1].includes(rx.pullup)||tx!==rx&&tx.pullup!==0)throw new Error('Invalid TMC UART pins or OID');
 for(const format of Object.values(tmcUartFormats))d.lookup(format);
 const frequency=Number(d.constant('CLOCK_FREQ')),mcu=d.hasConstant('MCU')?String(d.constant('MCU')):'',baud=/^(atmega|at90usb)/.test(mcu)?9000:40000,bitTime=Math.trunc(frequency/baud);
 if(!Number.isFinite(frequency)||frequency<=0||frequency>1e9||bitTime<1||bitTime>0xffffffff)throw new RangeError('Invalid TMC UART bit clock');
 const command=`config_tmcuart oid=${oid} rx_pin=${rx.pin} pull_up=${rx.pullup} tx_pin=${tx.pin} bit_time=${bitTime}`;d.encodeCommand(command);
 return Object.freeze({oid,baud,bitTime,commands:Object.freeze([command])});
}
const owners=new WeakMap<SerialSession,TmcUartBus>();
/** One FIFO and bus per configured MCU session. Firmware reports completion for
 * writes too; ACK alone must never permit a following IFCNT read. */
export function sessionTmcUart(session:SerialSession):TmcUartBus{
 session.assertActive();const existing=owners.get(session);if(existing)return existing;
 const d=session.dictionary;for(const format of Object.values(tmcUartFormats))d.lookup(format);
 const queue=session.commandQueue(),bus=new TmcUartBus({async transfer(oid,write,read,minClock,signal){
  session.assertActive();
  const payload=d.encode('tmcuart_send',{oid,write,read});
  try{
   // Query timeout is wall time, including scheduled release. Keep it bounded
   // by the session's 60-second horizon; never resend actuator writes here.
   const now=serialClock.now(),release=minClock===0n?now:session.clock.sync.systemTime(minClock),timeout=Math.max(5,release-now+5);
   if(!Number.isFinite(timeout)||timeout>60)throw new RangeError('TMC query exceeds scheduling horizon');
   const response=await session.queryOnQueue(queue,payload,'tmcuart_response',signal,{oid,retries:0,timeout,minClock,reqClock:minClock});
   const data=response.message.parameters.read;
   if(response.message.name!=='tmcuart_response'||response.message.parameters.oid!==oid||!(data instanceof Uint8Array)||data.length>10||read===0&&data.length!==0)throw new Error('Malformed TMC MCU response');
   return data.slice();
  }catch(error){try{await session.stop(error);}catch(stop){throw new AggregateError([error,stop],'TMC transaction and MCU stop failed',{cause:error});}throw error;}
 }});owners.set(session,bus);return bus;
}
