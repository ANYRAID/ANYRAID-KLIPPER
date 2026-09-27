// Part-cooling configuration from klippy/extras/fan.py. GPL-3.0-or-later.
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {PrinterPins,type PhysicalPinMap} from '../protocol/pins.ts';
import {mcuOids} from '../protocol/mcu-oids.ts';
import type {StepperMCU} from './stepper.ts';
import {compilePWM} from '../outputs/pwm.ts';
import {readPrintClock,type PrintClockTimeline} from '../timing/print-clock-timeline.ts';
import type {SecondarySync} from '../timing/secondary-sync.ts';
export interface FanClock {currentPrintTime:number;timeline?:PrintClockTimeline;synchronizer?:SecondarySync;calibration:Readonly<{offset:number;frequency:number}>}
export interface CoolingFanRequest {section:string;oid?:number;enableOid?:number;minimumScheduleTime:number;capacity?:number}
/** Cold-start planning only. Generation-capable firmware is required so a
 * normal finish can cancel accepted future output writes, not merely append 0. */
export function compileConfiguredCoolingFans<T>(reader:ConfigurationReader,pins:PrinterPins<T>,mcus:ReadonlyMap<string,StepperMCU<T>>,clocks:ReadonlyMap<string,FanClock>,requests:readonly CoolingFanRequest[]){
 if(!requests.length||requests.length>64||new Set(requests.map(r=>r.section)).size!==requests.length)throw new Error('Invalid cooling fan batch');
 const maps=new Map<string,PhysicalPinMap>();
 const fans=requests.map(request=>{
  const section=reader.section(request.section),maxPower=section.getFloat('max_power',{defaultValue:1,above:0,maxval:1}),kickStartTime=section.getFloat('kick_start_time',{defaultValue:.1,minval:0}),offBelow=section.getFloat('off_below',{defaultValue:0,minval:0,maxval:1}),cycleTime=section.getFloat('cycle_time',{defaultValue:.01,above:0}),hardware=section.getBoolean('hardware_pwm',{defaultValue:false});
  const thermal=request.section.startsWith('heater_fan '),shutdownSpeed=section.getFloat('shutdown_speed',{defaultValue:thermal?1:0,minval:0,maxval:1}),shutdownPower=Math.min(maxPower,shutdownSpeed);
  if(!thermal&&!request.section.startsWith('controller_fan ')&&shutdownPower!==0)throw new Error('Part-cooling runtime requires zero shutdown speed');
  if(section.hasOption('tachometer_pin'))throw new Error('Fan tachometer requires a pulse-counter provider');
  const {minimumScheduleTime,capacity=1024}=request;if(!Number.isFinite(minimumScheduleTime)||minimumScheduleTime<=0||!Number.isInteger(capacity)||capacity<1||capacity>65536)throw new Error('Invalid cooling fan scheduling policy');
  const enable=section.get('enable_pin',{defaultValue:null});if(enable===null&&request.enableOid!==undefined)throw new Error('Fan enable OID has no pin');
  return {request,config:Object.freeze({shutdownPower,maxPower,kickStartTime,offBelow,minimumScheduleTime,capacity}),cycleTime,outputs:[{description:section.get('pin'),hardware,oid:request.oid,role:'pwm',shutdown:shutdownPower},...enable===null?[]:[{description:enable,hardware:false,oid:request.enableOid,role:'enable',shutdown:shutdownPower?1:0}]]};
 });
 const outputs=fans.flatMap(f=>f.outputs.map(output=>{
  const pin=pins.parse(output.description,{canInvert:true}),mcu=mcus.get(pin.chipName),mapping=clocks.get(pin.chipName);
  if(!mcu||mcu.chip!==pin.chip||!mapping)throw new Error('Cooling fan MCU or clock ownership differs');
  // Calibrated print-clock frequency may differ from the nominal oscillator.
  const clock=readPrintClock(mapping.calibration,mapping.timeline);
  const resolver=pins.resolver(pin.chipName).clone(),enumeration=mcu.dictionary.pinEnumeration;
  for(const [name,value] of Object.entries(mcu.dictionary.constants))if(name.startsWith('RESERVE_PINS_')){if(typeof value!=='string')throw new Error('Invalid firmware pin reservation');for(const p of value.split(','))if(p.trim())resolver.reserve(p.trim(),name.slice(13));}
  const resolved=resolver.resolve([`claim pin=${pin.pin}`])[0].slice(10),reserved=resolver.physicalReservations(enumeration);maps.set(pin.chipName,{pins:enumeration,reserved});
  return {...output,pin:Object.freeze({...pin,pin:resolved}),mcu,clock,timeline:mapping.timeline,currentPrintTime:mapping.currentPrintTime,cycleTime:output.role==='enable'?.01:f.cycleTime,owner:`fan:${f.request.section}:${output.role}`};
 }));
 return mcuOids(pins).claim(outputs.map(o=>({mcu:o.pin.chipName,owner:o.owner,oid:o.oid})),oids=>{
  const compiled=outputs.map((o,i)=>{
   const pwm=compilePWM(o.mcu.chip,o.mcu.dictionary,{oid:oids[i],pin:o.pin,hardware:o.hardware,cycleTime:o.cycleTime,maxDuration:0,start:0,shutdown:o.shutdown,currentPrintTime:o.currentPrintTime},o.clock.clockAt);
   for(const command of [...pwm.commands,...pwm.restart,...pwm.init])o.mcu.dictionary.encodeCommand(command);
   o.mcu.dictionary.lookup(o.hardware?'reset_pwm_out_generation oid=%c generation=%u':'reset_digital_out_generation oid=%c generation=%u');
   o.mcu.dictionary.lookup(o.hardware?'queue_pwm_out_generation oid=%c clock=%u value=%hu generation=%u':'queue_digital_out_generation oid=%c clock=%u on_ticks=%u generation=%u');
   return {mcu:o.pin.chipName,pwm,clock:o.clock,timeline:o.timeline};
  });
  const acquired=pins.lookupBatch(outputs.map(o=>({description:o.description,options:{canInvert:true},exclusive:true})),maps),plans=compiled.map((p,i)=>Object.freeze({...p,pin:acquired[i]}));let offset=0;
  return Object.freeze(fans.map(f=>{const output=plans[offset++],enable=f.outputs.length===2?plans[offset++]:undefined;return Object.freeze({section:f.request.section,config:f.config,output,enable});}));
 });
}
