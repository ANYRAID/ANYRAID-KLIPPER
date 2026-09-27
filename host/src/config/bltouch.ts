import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {PrinterPins,type PhysicalPinMap} from '../protocol/pins.ts';
import {mcuOids} from '../protocol/mcu-oids.ts';
import type {StepperMCU} from './stepper.ts';
import type {FanClock} from './cooling-fan.ts';
import type {compileConfiguredHoming} from './homing.ts';
import {readPrintClock} from '../timing/print-clock-timeline.ts';
import {compilePWM} from '../outputs/pwm.ts';
import {TriggerSyncProtocol} from '../inputs/trsync.ts';
import type {BLTouchSettings} from '../homing/bltouch-device.ts';
export function readBLTouchSettings(reader:ConfigurationReader):Readonly<BLTouchSettings>|undefined{
 if(!reader.hasSection('bltouch'))return undefined;
 if(reader.hasSection('probe'))throw new Error('BLTouch and probe cannot own the same probe interface');
 const c=reader.section('bltouch'),mode=c.get('set_output_mode',{defaultValue:null});if(mode!==null&&mode!=='5V'&&mode!=='OD')throw new Error('Invalid BLTouch output mode');
 for(const key of ['activate_gcode','deactivate_gcode'])if(c.hasOption(key)&&c.get(key).trim())throw new Error('BLTouch uses typed device actions, not activation macros');
 return Object.freeze({pinMoveTime:c.getFloat('pin_move_time',{defaultValue:.680,above:0}),stowOnEachSample:c.getBoolean('stow_on_each_sample',{defaultValue:true}),touchMode:c.getBoolean('probe_with_touch_mode',{defaultValue:false}),pinUpNotTriggered:c.getBoolean('pin_up_reports_not_triggered',{defaultValue:true}),pinUpTouchTriggered:c.getBoolean('pin_up_touch_mode_reports_triggered',{defaultValue:true}),outputMode:mode});
}
/** Shares the previously compiled sensor with homing, but allocates a distinct
 * stationary-verification trigger. All resources remain owned by cold start. */
export function compileConfiguredBLTouch<T>(reader:ConfigurationReader,pins:PrinterPins<T>,mcus:ReadonlyMap<string,StepperMCU<T>>,clocks:ReadonlyMap<string,FanClock>,homing:ReturnType<typeof compileConfiguredHoming<T>>){
 const settings=readBLTouchSettings(reader);if(!settings)return undefined;
 const sensor=homing.find(h=>h.section==='bltouch');if(!sensor)throw new Error('BLTouch requires a compiled sensor owner');
 const description=reader.section('bltouch').get('control_pin'),pin=pins.parse(description,{canInvert:true}),mcu=mcus.get(pin.chipName),mapping=clocks.get(pin.chipName),sensorMCU=mcus.get(sensor.mcu);
 if(!mcu||mcu.chip!==pin.chip||!mapping||!sensorMCU||sensor.pin.chip!==sensorMCU.chip)throw new Error('BLTouch MCU or clock ownership differs');
 const clock=readPrintClock(mapping.calibration,mapping.timeline),resolver=pins.resolver(pin.chipName).clone(),enumeration=mcu.dictionary.pinEnumeration;
 for(const [name,value] of Object.entries(mcu.dictionary.constants))if(name.startsWith('RESERVE_PINS_')){if(typeof value!=='string')throw new Error('Invalid firmware pin reservation');for(const p of value.split(','))if(p.trim())resolver.reserve(p.trim(),name.slice(13));}
 const resolved=resolver.resolve([`claim pin=${pin.pin}`])[0].slice(10),maps=new Map<string,PhysicalPinMap>([[pin.chipName,{pins:enumeration,reserved:resolver.physicalReservations(enumeration)}]]);
 return mcuOids(pins).claim([{mcu:pin.chipName,owner:'bltouch:control'},{mcu:sensor.mcu,owner:'bltouch:verification'}],oids=>{
  const pwm=compilePWM(mcu.chip,mcu.dictionary,{oid:oids[0],pin:{...pin,pin:resolved},cycleTime:.020,maxDuration:0,start:0,shutdown:0,currentPrintTime:mapping.currentPrintTime},clock.clockAt),verification=new TriggerSyncProtocol(sensorMCU.dictionary,oids[1]);
  for(const command of [...pwm.commands,...pwm.restart,...pwm.init])mcu.dictionary.encodeCommand(command);
  mcu.dictionary.lookup('reset_digital_out_generation oid=%c generation=%u');mcu.dictionary.lookup('queue_digital_out_generation oid=%c clock=%u on_ticks=%u generation=%u');
  for(const command of [...verification.commands,...verification.restart])sensorMCU.dictionary.encodeCommand(command);
  const [acquired]=pins.lookupBatch([{description,options:{canInvert:true},exclusive:true}],maps);
  return Object.freeze({settings,sensor,verification:Object.freeze({mcu:sensor.mcu,protocol:verification}),output:Object.freeze({mcu:pin.chipName,pin:acquired,pwm,clock,timeline:mapping.timeline})});
 });
}
