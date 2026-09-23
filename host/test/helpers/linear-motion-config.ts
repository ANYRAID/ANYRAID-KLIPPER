import {ConfigurationReader} from '../../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../../src/moonraker/config-source.ts';
export function linearMotionReader(overrides:Record<string,Record<string,string>>={}){
 const sections:Record<string,Record<string,string>>={printer:{kinematics:'cartesian',max_velocity:'100',max_accel:'1000',max_z_velocity:'5',max_z_accel:'100'},extruder:{nozzle_diameter:'.4',filament_diameter:'1.75',max_extrude_cross_section:'1',max_extrude_only_velocity:'30',max_extrude_only_accel:'100'}};
 for(const [i,name] of ['stepper_x','stepper_y','stepper_z'].entries())sections[name]={position_max:i?'200':'52',position_endstop:i?'0':'51',homing_positive_dir:'false',homing_speed:'10',homing_retract_dist:'0'};
 for(const [name,values] of Object.entries(overrides))sections[name]={...sections[name],...values};
 return new ConfigurationReader(new ConfigurationSource('/linear-machine.cfg',sections,[]),null);
}
