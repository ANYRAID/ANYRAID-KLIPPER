import {hardwareStartupFixture} from './hardware-startup.ts';
import {hardwareLayout} from './configured-hardware.ts';
import {ConfigurationReader} from '../../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../../src/moonraker/config-source.ts';
import {startConfiguredHardware,type HardwareStartupOptions} from '../../src/runtime/configured-hardware.ts';
export const initialMotionOptions={position:[0,0,0,0],routes:[{id:'xyz'},{id:'e',extrusionAxis:3}]};
export async function initialMotionSetup(reverse=false,full=false,bed=false,autostart=true,buttons=false){
 const f=await hardwareStartupFixture(false,reverse,true,autostart,buttons);
 try{
  const sections:Record<string,Record<string,string>>={
   board_pins:{aliases:'STEP=PA0, POWER=<5V>'},
   stepper_x:{step_pin:'STEP',dir_pin:'PA1',rotation_distance:'40',microsteps:'16',enable_pin:'!PA2',endstop_pin:'^PA3'},
   fan:{pin:'aux:PA0',enable_pin:'aux:PA3'},
   extruder:{step_pin:'PA4',dir_pin:'PA5',enable_pin:'!PA6',rotation_distance:'40',microsteps:'16',heater_pin:'aux:PA1',sensor_pin:'aux:PA2',sensor_type:'Generic 3950',min_temp:'0',max_temp:'300',control:'watermark'},
  };
  if(full){
   sections.printer={kinematics:'cartesian',max_velocity:'100',max_accel:'1000'};
   for(const [axis,step,dir,endstop] of [['y','PA7','PA8','PA11'],['z','PA9','PA10','PA12']])sections[`stepper_${axis}`]={step_pin:step,dir_pin:dir,endstop_pin:endstop,rotation_distance:'40',microsteps:'16',enable_pin:'!PA2'};
   for(const axis of ['x','y','z'])Object.assign(sections[`stepper_${axis}`],{position_max:'200',position_endstop:'0',homing_retract_dist:'0'});
   Object.assign(sections.extruder,{nozzle_diameter:'.4',filament_diameter:'1.75'});
  }
  if(bed)sections.heater_bed={heater_pin:'aux:PA4',sensor_pin:'aux:PA5',sensor_type:'Generic 3950',min_temp:'0',max_temp:'130',control:'watermark'};
  if(buttons)sections['filament_switch_sensor tool']={switch_pin:'^aux:PA6',debounce_delay:'.01'};
  const reader=new ConfigurationReader(new ConfigurationSource('/initial.cfg',sections,[]),null);
  const extra=(full?['y','z']:[]).map(axis=>({section:`stepper_${axis}`,emitter:axis,enableLeadTime:.001}));
  const layout={...hardwareLayout,boards:[],heaters:[...hardwareLayout.heaters,...bed?[{section:'heater_bed'}]:[]],homing:full?['x','y','z'].map(axis=>({section:`stepper_${axis}`,mcus:['mcu']})):hardwareLayout.homing,steppers:[...hardwareLayout.steppers,...extra,{section:'extruder',emitter:'e',enableLeadTime:.001}]};
  const hardwareOptions:HardwareStartupOptions={heaterGcodeIds:bed?{extruder:'T',heater_bed:'B'}:undefined,motion:[{emitter:'x',queueId:'xyz',mode:'x'},...extra.map(e=>({emitter:e.emitter,queueId:'xyz',mode:e.emitter as 'y'|'z'})),{emitter:'e',queueId:'e',mode:'extruder'}]};
  return {...f,reader,layout,hardwareOptions};
 }catch(error){await f.close();throw error;}
}

export async function initialMotionFixture(reverse=false,full=false,bed=false){
 const f=await initialMotionSetup(reverse,full,bed);try{const hardware=await startConfiguredHardware(f.reader,f.group,f.clocks,f.layout,f.hardwareOptions,f.signal);return {...f,hardware};}catch(error){await f.close();throw error;}
}
