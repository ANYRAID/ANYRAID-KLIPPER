import type {DecodedMessage} from './dictionary.ts';
import type {ClockSync} from '../timing/clock-sync.ts';
export interface FirmwareFaultDetails {
 readonly event:'shutdown'|'is_shutdown'|'starting';
 readonly reason:string;
 readonly receiveTime:number;
 readonly clock32?:number;
 /** Nearest epoch of the last synchronized clock, not a fresh clock sample. */
 readonly clock?:bigint;
}
export class FirmwareFault extends Error {
 readonly details:Readonly<FirmwareFaultDetails>;
 constructor(details:FirmwareFaultDetails){super(details.event==='starting'?'MCU spontaneous restart':`MCU shutdown: ${details.reason}`);this.name='FirmwareFault';this.details=Object.freeze({...details});}
}
/** Mandatory transport fence, before query matching or optional application
 * callbacks. Even incomplete diagnostic fields must never suppress a stop. */
export function firmwareFault(message:DecodedMessage,receiveTime:number,clock?:Pick<ClockSync,'nearestClock'>):FirmwareFault|undefined {
 const event=message.name;if(event!=='shutdown'&&event!=='is_shutdown'&&event!=='starting')return;
 if(event==='starting')return new FirmwareFault({event,reason:'Spontaneous restart',receiveTime});
 const rawReason=message.parameters.static_string_id;
 const reason=typeof rawReason==='string'?rawReason:typeof rawReason==='number'?`MCU reason ${rawReason}`:'Unknown MCU shutdown reason';
 const rawClock=message.parameters.clock;
 const clock32=typeof rawClock==='number'&&Number.isInteger(rawClock)&&rawClock>=0&&rawClock<=0xffffffff?rawClock:undefined;
 return new FirmwareFault({event,reason,receiveTime,...(clock32===undefined?{}:{clock32,...(clock?{clock:clock.nearestClock(clock32)}:{})})});
}
