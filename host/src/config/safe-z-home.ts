import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {safeZHomingSettings} from '../homing/safe-z-home.ts';
export function readSafeZHoming(reader:ConfigurationReader,limits:Parameters<typeof safeZHomingSettings>[1]){
 if(!reader.hasSection('safe_z_home'))return undefined;
 if(reader.hasSection('homing_override'))throw new Error('safe_z_home conflicts with homing_override');
 const c=reader.section('safe_z_home');return safeZHomingSettings({position:c.getFloatList('home_xy_position',{separator:',',count:2}) as [number,number],hop:c.getFloat('z_hop',{defaultValue:0,minval:0}),hopSpeed:c.getFloat('z_hop_speed',{defaultValue:15,above:0}),speed:c.getFloat('speed',{defaultValue:50,above:0}),moveToPrevious:c.getBoolean('move_to_previous',{defaultValue:false})},limits);
}
