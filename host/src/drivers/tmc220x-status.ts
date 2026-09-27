import type {Tmc220xMonitor} from './tmc220x-monitor.ts';
import type {planTmc220x} from './tmc220x.ts';
// DRV_STATUS field layout from klippy/extras/tmc2208.py (GPL-3.0-or-later).
const fields:readonly (readonly [string,number,number])[]=[['otpw',0,1],['ot',1,1],['s2ga',2,1],['s2gb',3,1],['s2vsa',4,1],['s2vsb',5,1],['ola',6,1],['olb',7,1],['t120',8,1],['t143',9,1],['t150',10,1],['t157',11,1],['cs_actual',16,31],['stealth',30,1],['stst',31,1]];
/** Read-only snapshot projection: never queries hardware. Current values are
 * the acknowledged configured quantization, not an electrical measurement. */
export function tmc220xStatusReader(plan:ReturnType<typeof planTmc220x>,monitor:Pick<Tmc220xMonitor,'status'>){
 const run=plan.current.runCurrent,hold=plan.current.holdCurrent;let previous:number|null=null,decoded:Readonly<Record<string,number>>=Object.freeze({});
 return ()=>{
  const status=monitor.status,active=!status.closed&&status.checks>0;
  if(status.drvStatus!==previous){previous=status.drvStatus;const next:Record<string,number>={};if(previous!==null)for(const [name,shift,mask] of fields){const value=(previous>>>shift)&mask;if(value)next[name]=value;}decoded=Object.freeze(next);}
  return {mcu_phase_offset:null,phase_offset_position:null,run_current:run,hold_current:hold,drv_status:active?decoded:null,temperature:null,native_monitor:{active,checks:status.checks,fault:status.fault!==undefined,gstat:status.gstat}};
 };
}
