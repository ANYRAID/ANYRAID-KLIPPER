import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {validateArcResolution} from '../gcode/arcs.ts';
export function readArcResolution(reader:ConfigurationReader):number {
 return validateArcResolution(reader.hasSection('gcode_arcs')?reader.section('gcode_arcs').getFloat('resolution',{defaultValue:1,above:0}):1);
}
