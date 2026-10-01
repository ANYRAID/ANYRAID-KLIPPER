import type {productMachineFixture} from './product-machine.ts';
import {atFirmwareClock} from './firmware-clock-timer.ts';
import {emitClientTemperatures} from './client-temperature.ts';
/** PTY simulation only: real protocol homing/ADC, no physical thermal model.
 * Once a heater has produced PWM its simulated sensor reaches 220/80 C.
 * Never load this adapter for a real machine. */
export function simulateClientFirmware(f:Awaited<ReturnType<typeof productMachineFixture>>,starts:readonly number[]=f.transport.firmware.map(()=>0)){
 const timers=new Set<ReturnType<typeof setTimeout>>(),device=f.transport.firmware[0],baseline=[...f.transport.stops];
 let cursor=starts[0]??0,homed=0;const verification=new Set<number>(),heated=new Set<number>();
 const stopped=(index:number)=>f.transport.stops[index]!==baseline[index];
 // Observe commands actually accepted by firmware, not a second decoder with
 // a stale sequence after reconnect. History before this profile is excluded.
 const poll=setInterval(()=>{if(stopped(0)){for(const timer of timers)clearTimeout(timer);timers.clear();return;}
  for(;cursor<device.outputs.length;cursor++){const entry=device.outputs[cursor],p=entry.parameters;
   if(entry.name==='trsync_start'&&Number(p.expire_reason)===3)verification.add(Number(p.oid));
   if(entry.name==='trsync_start'&&p.report_ticks===0)device.setTriggerReason(2,Number(p.oid));
   if(entry.name!=='endstop_home'||!Number(p.sample_count))continue;
   const oid=Number(p.trsync_oid),clock=Number(p.clock),verify=verification.has(oid);
   atFirmwareClock(timers,()=>device.currentClock(),clock,verify?1:150,()=>{if(stopped(0))return;if(!verify)homed++;
    device.setTriggerReason(1,oid);device.setEndstopState({homing:0,pin_value:verify?Number(p.pin_value):0,next_clock:clock+Number(p.rest_ticks)},Number(p.oid));device.emit('trsync_state',{oid,can_trigger:0,trigger_reason:1,clock});
   });
  }
 },2);
 const thermal=setInterval(()=>emitClientTemperatures(f.transport.firmware,baseline.map((_,i)=>stopped(i)?1:0),(index,oid)=>{
  const history=f.transport.firmware[index].outputs,outputs=history.slice(starts[index]??0),sensor=history.findLast(e=>e.name==='config_analog_in'&&Number(e.parameters.oid)===oid),pin=sensor?.parameters.pin;
  // RESTART reuses valid MCU configuration. Configuration remains historical;
  // heater activation and ADC requests must still belong to the current owner.
  const nozzle=pin==='PA2'||pin===2,heater=history.findLast(e=>e.name==='config_digital_out'&&(e.parameters.pin===(nozzle?'PA1':'PA4')||e.parameters.pin===(nozzle?1:4)));
  if(heater&&outputs.some(e=>e.name==='queue_digital_out_generation'&&e.parameters.oid===heater.parameters.oid&&Number(e.parameters.on_ticks)>0))heated.add(oid);
  return heated.has(oid)?nozzle?220:80:25;
 },starts),100);
 return {get homed(){return homed;},close(){clearInterval(poll);clearInterval(thermal);for(const timer of timers)clearTimeout(timer);timers.clear();}};
}
