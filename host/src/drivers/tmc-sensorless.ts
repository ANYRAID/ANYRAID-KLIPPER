// Sensorless homing mode transitions from TMCVirtualPinHelper. GPL-3.0-or-later.
import type {TmcUartDevice} from './tmc-uart.ts';
export interface SensorlessRegister {readonly name:string;readonly address:number;readonly value:number}
export interface SensorlessPlan {readonly enter:readonly SensorlessRegister[];readonly restore:readonly SensorlessRegister[]}
/** Pure register plan. The caller supplies the current acknowledged register
 * image and excludes other writers until restoration finishes. */
export function planTmcSensorless(model:string,registers:readonly SensorlessRegister[],diag?:0|1):SensorlessPlan {
 if(!['tmc2209','tmc2130','tmc5160','tmc2240'].includes(model))throw new Error('Unsupported sensorless driver');
 if(model==='tmc2209'?diag!==undefined:diag!==0&&diag!==1)throw new Error('Invalid sensorless DIAG selection');
 const image=new Map<string,SensorlessRegister>();
 for(const r of registers){if(image.has(r.name)||!Number.isInteger(r.value)||r.value<0||r.value>0xffffffff)throw new Error('Invalid sensorless register image');image.set(r.name,r);}
 const enter:SensorlessRegister[]=[],restore:SensorlessRegister[]=[];
 const get=(name:string,address:number)=>{const r=image.get(name);if(!r||r.address!==address)throw new Error('Missing sensorless register '+name);return r;};
 const set=(name:string,address:number,mask:number,value:number)=>{const r=get(name,address);restore.push(Object.freeze({...r}));enter.push(Object.freeze({...r,value:((r.value&~mask)|(value&mask))>>>0}));};
 if(model==='tmc2209'){set('TPWMTHRS',0x13,0xfffff,0);set('GCONF',0,4,0);}
 else {const mask=1<<(diag===0?7:8),sg4=model==='tmc2240'&&(get('SG4_THRS',0x74).value&255)!==0;set('GCONF',0,4|mask,mask|(sg4?4:0));if(sg4)set('TPWMTHRS',0x13,0xfffff,0);}
 if((get('TCOOLTHRS',0x14).value&0xfffff)===0)set('TCOOLTHRS',0x14,0xfffff,0xfffff);
 if(model!=='tmc2209')set('THIGH',0x15,0xfffff,0);
 return Object.freeze({enter:Object.freeze(enter),restore:Object.freeze(restore)});
}
/** Homing owner must stop/drain prior motion before enter, retain exclusive
 * motion ownership, and confirm the seek has stopped before restore. On any
 * ambiguous write it must retire the hardware; never restore during a faulting
 * seek. This class deliberately does not accept or produce motion authority. */
export class TmcSensorlessMode {
 #device:Pick<TmcUartDevice,'write'>;#plan:SensorlessPlan;#lifetime:AbortSignal;#fault:(cause:unknown)=>void;
 #state:'idle'|'entering'|'active'|'restoring'|'failed'='idle';
 constructor(device:Pick<TmcUartDevice,'write'>,model:string,registers:readonly SensorlessRegister[],diag:0|1|undefined,lifetime:AbortSignal,fault:(cause:unknown)=>void){
  this.#device=device;this.#plan=planTmcSensorless(model,registers,diag);this.#lifetime=lifetime;this.#fault=fault;
 }
 get state(){return this.#state;}
 enter(signal:AbortSignal){return this.#write('idle','entering','active',this.#plan.enter,signal);}
 restore(signal:AbortSignal){return this.#write('active','restoring','idle',this.#plan.restore,signal);}
 async #write(expected:'idle'|'active',pending:'entering'|'restoring',done:'active'|'idle',registers:readonly SensorlessRegister[],signal:AbortSignal){
  if(this.#state!==expected)throw new Error('Sensorless mode owner unavailable');
  const combined=AbortSignal.any([signal,this.#lifetime]);
  // A cancelled entry has made no changes. A cancelled restoration leaves a
  // homing mode installed and therefore must retire the hardware.
  if(expected==='idle')combined.throwIfAborted();
  this.#state=pending;
  try{for(const r of registers){combined.throwIfAborted();await this.#device.write(r.address,r.value,combined);}combined.throwIfAborted();this.#state=done;}
  catch(error){this.#state='failed';this.#fault(error);throw error;}
 }
}
