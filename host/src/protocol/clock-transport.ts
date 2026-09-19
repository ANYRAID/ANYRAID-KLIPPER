import {MessageDictionary,type DecodedMessage} from './dictionary.ts';
import {ProtocolError} from './codec.ts';
import type {ClockTransport,UptimeSample} from '../timing/clock-runtime.ts';
import type {ClockSample,ReleaseEstimate} from '../timing/clock-sync.ts';
export interface TimedResponse {message:DecodedMessage;sentTime:number;receiveTime:number}
/** The connection owns ACK/retry, response matching, and monotonic timestamps. */
export interface ClockConnection {
 query(payload:Uint8Array,responseName:string,signal:AbortSignal):Promise<TimedResponse>;
 setClockEstimate(estimate:ReleaseEstimate):void;
 stop(cause:unknown):Promise<void>;
}
function uint32(value:unknown):number{if(typeof value!=='number'||!Number.isInteger(value)||value<0||value>0xffffffff)throw new ProtocolError('Invalid MCU clock counter');return value;}
export class DictionaryClockTransport implements ClockTransport {
 readonly frequency:number;#connection:ClockConnection;#uptime:Uint8Array;#clock:Uint8Array;
 constructor(dictionary:MessageDictionary,connection:ClockConnection){
  let freq=dictionary.constant('CLOCK_FREQ');if(typeof freq==='string'&&/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(freq.trim()))freq=Number(freq);if(typeof freq!=='number'||!Number.isFinite(freq)||freq<=0||freq>1e9)throw new ProtocolError('Invalid firmware CLOCK_FREQ');
  this.frequency=freq;this.#connection=connection;this.#uptime=dictionary.encode('get_uptime',{});this.#clock=dictionary.encode('get_clock',{});
 }
 async #query(payload:Uint8Array,name:string,signal:AbortSignal):Promise<TimedResponse>{signal.throwIfAborted();const reply=await this.#connection.query(payload.slice(),name,signal);signal.throwIfAborted();if(reply.message.name!==name)throw new ProtocolError('Unexpected clock query response');return reply;}
 async uptime(signal:AbortSignal):Promise<UptimeSample>{const r=await this.#query(this.#uptime,'uptime',signal);return {high:uint32(r.message.parameters.high),clock32:uint32(r.message.parameters.clock),sentTime:r.sentTime,receiveTime:r.receiveTime};}
 async queryClock(signal:AbortSignal):Promise<ClockSample>{const r=await this.#query(this.#clock,'clock',signal);return {clock32:uint32(r.message.parameters.clock),sentTime:r.sentTime,receiveTime:r.receiveTime};}
 setClockEstimate(estimate:ReleaseEstimate):void{this.#connection.setClockEstimate(estimate);}
 stop(cause:unknown):Promise<void>{return this.#connection.stop(cause);}
}
