import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {validateRetraction,type RetractionSettings} from '../gcode/retraction.ts';
export function readRetraction(reader:ConfigurationReader):RetractionSettings|undefined {
 if(!reader.hasSection('firmware_retraction'))return;
 const s=reader.section('firmware_retraction');return validateRetraction({retract_length:s.getFloat('retract_length',{defaultValue:0,minval:0}),retract_speed:s.getFloat('retract_speed',{defaultValue:20,minval:1}),unretract_extra_length:s.getFloat('unretract_extra_length',{defaultValue:0,minval:0}),unretract_speed:s.getFloat('unretract_speed',{defaultValue:10,minval:1})});
}
