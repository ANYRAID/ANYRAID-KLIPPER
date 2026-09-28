import test from 'node:test';
import assert from 'node:assert/strict';
import {validateNativePrinterSections} from '../src/config/native-printer-sections.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
const reader=(sections:string[])=>new ConfigurationReader(new ConfigurationSource('/printer.cfg',Object.fromEntries(sections.map(s=>[s,{}])),[]),null);
test('native component preflight accepts supported owners and their bound configuration',()=>{
 validateNativePrinterSections(reader(['printer','mcu','mcu aux','stepper_x','stepper_y','stepper_z','stepper_z1','extruder','heater_bed','heater_generic chamber','verify_heater chamber','verify_heater extruder','tmc2209 stepper_x','tmc2240 stepper_z1','tmc5160 extruder','endstop_phase stepper_x','bed_mesh','bed_mesh saved','board_pins','board_pins aux','thermistor custom','adc_temperature custom','fan','fan_generic auxiliary','heater_fan hotend','controller_fan board','filament_switch_sensor material','filament_motion_sensor encoder','idle_timeout','input_shaper','gcode_arcs','firmware_retraction','safe_z_home','probe','endstop_phase']));
 validateNativePrinterSections(reader(['bed_tilt','bltouch','exclude_object','quad_gantry_level','temperature_fan chamber']));
});
test('native component preflight rejects unknown components, misspellings and orphaned owners',()=>{
 assert.throws(()=>validateNativePrinterSections(new ConfigurationReader(new ConfigurationSource('/printer.cfg',{exclude_object:{unknown:'1'}},[]),null)),/does not accept options/);
 for(const section of ['gcode_macro START','homing_override','delayed_gcode boot','heater_fna hotend','verify_heater missing','tmc2209 missing','tmc9999 stepper_x','endstop_phase missing','bed_mesh orphan','fan_generic ','board_pins ']){
  assert.throws(()=>validateNativePrinterSections(reader(['printer','stepper_x',section])),error=>String(error).includes('['+section+']'));
 }
});
test('Delta preflight recognizes tower ownership and rejects unbound calibration or macros',()=>{
 validateNativePrinterSections(reader(['printer','mcu','stepper_a','stepper_b','stepper_c','stepper_a1','extruder','tmc2209 stepper_a1','verify_heater extruder','bed_mesh','bed_mesh saved','servo latch','probe']),'delta');
 for(const section of ['stepper_x','tmc2209 stepper_z','bltouch','endstop_phase','endstop_phase stepper_a','z_tilt','quad_gantry_level','safe_z_home','bed_tilt','bed_screws','screws_tilt_adjust','skew_correction','skew_correction saved','gcode_macro START'])assert.throws(()=>validateNativePrinterSections(reader(['printer','stepper_a','stepper_b','stepper_c',section]),'delta'),error=>String(error).includes('['+section+']'));
});
