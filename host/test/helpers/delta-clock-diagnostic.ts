import type {startConfiguredDeltaProductService} from '../../src/runtime/product-service.ts';
import {serialClock} from '../../src/protocol/serial-queue.ts';
type Printer=Awaited<ReturnType<typeof startConfiguredDeltaProductService>>['printer'];
/** Test-only observations of the exact historical maps used by homing. No
 * calibration, reservation, history retirement or device command is issued. */
export function deltaClockDiagnostic(printer:Printer,member:number,trigger?:number){
 const configurations=printer.hardware.plan.configurations,now=serialClock.now();
 const primary=configurations.find(c=>c.physicalMember===member);
 const read=<T>(work:()=>T)=>{try{return work();}catch(error){return {unavailable:String(error)};}};
 const printTime=trigger===undefined?undefined:read(()=>{
  if(!primary)throw new Error('Unknown physical clock member');
  return primary.timeline.printTimeAtClock(BigInt(trigger));
 });
 return {primary:primary?.mcu,trigger,printTime,members:configurations.map(c=>({
  mcu:c.mcu,physicalMember:c.physicalMember,revision:c.session.clock.sync.revision,
  estimate:c.session.clock.sync.estimate,estimatedClock:read(()=>c.session.clock.sync.getClock(now)),
  timeline:c.timeline.status,synchronizer:c.synchronizer?.mapping,
  mappedTrigger:typeof printTime==='number'?read(()=>c.timeline.clockAt(printTime)):undefined,
 }))};
}
