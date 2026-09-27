import type {Tmc220xMonitor} from './tmc220x-monitor.ts';
// DRV_STATUS field layout from klippy/extras/tmc2208.py (GPL-3.0-or-later).
const fields:readonly (readonly [string,number,number])[]=[['otpw',0,1],['ot',1,1],['s2ga',2,1],['s2gb',3,1],['s2vsa',4,1],['s2vsb',5,1],['ola',6,1],['olb',7,1],['t120',8,1],['t143',9,1],['t150',10,1],['t157',11,1],['cs_actual',16,31],['stealth',30,1],['stst',31,1]];
/** Read-only snapshot projection: never queries hardware. Current values are
 * the acknowledged configured quantization, not an electrical measurement. */
export function tmc220xStatusReader(plan:{model:string;current:Readonly<{runCurrent:number;holdCurrent:number}>},monitor:Pick<Tmc220xMonitor,'status'>,current=()=>plan.current){
 const selected=/^tmc(2130|5160)$/.test(plan.model)?[...plan.model==='tmc5160'?[['s2vsa',12,1],['s2vsb',13,1],['stealth',14,1]] as const:[],['sg_result',0,1023],['fsactive',15,1],['cs_actual',16,31],['stallguard',24,1],['ot',25,1],['otpw',26,1],['s2ga',27,1],['s2gb',28,1],['ola',29,1],['olb',30,1],['stst',31,1]] as const:fields;
 let previous:number|null=null,decoded:Readonly<Record<string,number>>=Object.freeze({});
 return ()=>{
  const status=monitor.status,active=!status.closed&&status.checks>0;
  if(status.drvStatus!==previous){previous=status.drvStatus;const next:Record<string,number>={};if(previous!==null)for(const [name,shift,mask] of selected){const value=(previous>>>shift)&mask;if(value)next[name]=value;}decoded=Object.freeze(next);}
  return {mcu_phase_offset:null,phase_offset_position:null,run_current:current().runCurrent,hold_current:current().holdCurrent,drv_status:active?decoded:null,temperature:null,native_monitor:{active,checks:status.checks,fault:status.fault!==undefined,gstat:status.gstat}};
 };
}
