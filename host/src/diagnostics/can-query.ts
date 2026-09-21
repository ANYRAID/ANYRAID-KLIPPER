// GPL-3.0-or-later. Klipper CAN discovery protocol (Kevin O'Connor, 2021).
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
export interface CanDiscoveryFrame {readonly id:number;readonly data:Uint8Array;}
export interface CanDiscoveryDevice {readonly uuid:string;readonly application:'Klipper'|'CanBoot'|'Unknown';}
export interface CanDiscoveryChannel {sendQuery():void;read():CanDiscoveryFrame|null;close():void;}
/** The six-byte UUID fits in Number, but bytes -> hex avoids any integer coercion. */
export function decodeCanDiscovery(frame:CanDiscoveryFrame):CanDiscoveryDevice|undefined{
 if(frame.id!==0x3f1||frame.data.length<7||frame.data.length>8||frame.data[0]!==0x20)return;
 const app=frame.data.length===7?1:frame.data[7];
 return {uuid:Buffer.from(frame.data.subarray(1,7)).toString('hex'),application:app===1?'Klipper':app===0x11?'CanBoot':'Unknown'};
}
interface Native {open(name:string):unknown;sendQuery(handle:unknown):void;read(handle:unknown):CanDiscoveryFrame|null;close(handle:unknown):void;}
/** A dedicated nonblocking socket. Never changes interface configuration or assigns node IDs. */
export function openCanDiscovery(name:string):CanDiscoveryChannel{
 if(!/^[A-Za-z0-9_.:-]{1,15}$/.test(name))throw new TypeError('Invalid CAN interface name');
 const native=createRequire(import.meta.url)(process.env.ANYRAID_CAN_QUERY_ADDON??'../../build/can-query.node') as Native,handle=native.open(name);
 return {sendQuery:()=>native.sendQuery(handle),read:()=>native.read(handle),close:()=>native.close(handle)};
}
/** Takes ownership of the channel even on cancellation/failure. Poll in bounded batches
 * so a busy bus cannot postpone the deadline or starve cancellation indefinitely. */
export async function queryCanDevices(channel:CanDiscoveryChannel,signal:AbortSignal,options:{durationMs?:number;maximumDevices?:number;now?:()=>number;wait?:(ms:number,signal:AbortSignal)=>Promise<void>}={}):Promise<CanDiscoveryDevice[]>{
 try{
  const duration=options.durationMs??2000,maximum=options.maximumDevices??4096,now=options.now??(()=>performance.now()),wait=options.wait??((ms,s)=>delay(ms,undefined,{signal:s}));
  if(!Number.isInteger(duration)||duration<1||duration>60000||!Number.isInteger(maximum)||maximum<1||maximum>65536)throw new RangeError('Invalid CAN discovery limits');
  signal.throwIfAborted();let previous=now();if(!Number.isFinite(previous))throw new Error('Invalid CAN discovery clock');const deadline=previous+duration,found=new Map<string,CanDiscoveryDevice>();
  channel.sendQuery();
  for(;;){
   signal.throwIfAborted();const current=now();if(!Number.isFinite(current)||current<previous)throw new Error('CAN discovery clock regressed');previous=current;if(current>=deadline)break;
   for(let i=0;i<256;i++){
    signal.throwIfAborted();const frame=channel.read();if(frame===null)break;const device=decodeCanDiscovery(frame);
    if(device&&!found.has(device.uuid)){if(found.size===maximum)throw new Error('CAN discovery device limit exceeded');found.set(device.uuid,device);}
   }
   await wait(Math.min(2,Math.max(0,deadline-current)),signal);
  }
  return [...found.values()];
 }finally{channel.close();}
}
