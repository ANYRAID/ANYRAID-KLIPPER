import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {readServo} from './servo.ts';
import {readOutputPin} from './output-pin.ts';
import {readTemperatureFan} from './temperature-fan.ts';
import {readFilamentEncoderPolicy} from '../inputs/filament-encoder.ts';
import {readFilamentPolicy} from '../inputs/filament-switch.ts';
/** Shared peripheral discovery; no motor or homing authority. */
export function planPrinterPeripherals(reader:ConfigurationReader,minimumScheduleTime:number){
 const sections=reader.sections();
 for(const section of sections.filter(n=>n.startsWith('temperature_fan ')))readTemperatureFan(reader,section);
 const fans=sections.filter(n=>n==='fan'||n.startsWith('fan_generic ')||n.startsWith('heater_fan ')||n.startsWith('controller_fan ')||n.startsWith('temperature_fan ')).map(section=>({section,minimumScheduleTime:minimumScheduleTime}));
 const heaters=sections.filter(n=>n==='extruder'||n==='heater_bed'||n.startsWith('heater_generic ')).map(section=>({section}));
 // Canonical nozzle/bed ordering is independent of source section ordering.
 heaters.sort((a,b)=>a.section==='extruder'?-1:b.section==='extruder'?1:a.section==='heater_bed'?-1:b.section==='heater_bed'?1:a.section.localeCompare(b.section));
 const buttons=sections.filter(n=>/^filament_(switch|motion)_sensor /.test(n)).map(section=>{if(section.startsWith('filament_motion_sensor '))readFilamentEncoderPolicy(reader,section);else readFilamentPolicy(reader,section);return {section};});
 const sensors=sections.filter(n=>n.startsWith('temperature_sensor ')||n.startsWith('temperature_fan ')).map(section=>({section}));
 const servos=sections.filter(n=>n.startsWith('servo ')).map(section=>{readServo(reader,section);return {section};});
 const outputPins=sections.filter(n=>n.startsWith('output_pin ')).map(section=>{readOutputPin(reader,section,3);return {section};});
 return {fans,heaters,sensors,...servos.length?{servos}:{},...outputPins.length?{outputPins}:{},...buttons.length?{buttons}:{}};
}
