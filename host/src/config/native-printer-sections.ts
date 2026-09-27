import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {ConfigurationError} from '../moonraker/config-source.ts';
const single=new Set(['printer','mcu','extruder','heater_bed','fan','board_pins','input_shaper','probe','bltouch','bed_mesh','bed_tilt','safe_z_home','gcode_arcs','firmware_retraction','idle_timeout','endstop_phase']);
const named=/^(?:mcu|board_pins|heater_generic|fan_generic|heater_fan|controller_fan|temperature_sensor|filament_switch_sensor|filament_motion_sensor|thermistor|adc_temperature) \S(?:.*\S)?$/;
/** Automatic native assembly must account for every declared component.
 * A supported section is not proof that every option has been implemented;
 * individual readers still own option and hardware validation. */
export function validateNativePrinterSections(reader:ConfigurationReader):void{
 const sections=reader.sections(),known=new Set(sections);
 const motors=new Set(sections.filter(s=>/^stepper_[xyz](?:[1-9][0-9]*)?$/.test(s)||s==='extruder'));
 const heaters=new Set(sections.filter(s=>s==='extruder'||s==='heater_bed'||s.startsWith('heater_generic ')).map(s=>s.trim().split(/\s+/).at(-1)!));
 const unsupported=sections.filter(section=>{
  if(single.has(section)||named.test(section)||motors.has(section))return false;
  if(section.startsWith('bed_mesh '))return !known.has('bed_mesh')||!section.slice(9).trim();
  if(section.startsWith('verify_heater '))return !heaters.has(section.slice(14));
  if(section.startsWith('endstop_phase '))return !motors.has(section.slice(14));
  const driver=/^tmc(?:2208|2209|2240|2130|5160) (.+)$/.exec(section);
  return !driver||!motors.has(driver[1]);
 });
 if(unsupported.length)throw new ConfigurationError('Native printer has unsupported or unbound configuration sections: '+unsupported.map(s=>'['+s+']').join(', '));
}
