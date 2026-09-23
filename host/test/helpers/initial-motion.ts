import {hardwareStartupFixture} from './hardware-startup.ts';
import {hardwareLayout} from './configured-hardware.ts';
import {ConfigurationReader} from '../../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../../src/moonraker/config-source.ts';
import {startConfiguredHardware} from '../../src/runtime/configured-hardware.ts';
export const initialMotionOptions={position:[0,0,0,0],routes:[{id:'xyz'},{id:'e',extrusionAxis:3}]};
export async function initialMotionFixture(reverse=false){
 const f=await hardwareStartupFixture(false,reverse,true);
 try{
  const reader=new ConfigurationReader(new ConfigurationSource('/initial.cfg',{
   stepper_x:{step_pin:'STEP',dir_pin:'PA1',rotation_distance:'40',microsteps:'16',enable_pin:'!PA2',endstop_pin:'^PA3'},
   fan:{pin:'aux:PA0',enable_pin:'aux:PA3'},
   extruder:{step_pin:'PA4',dir_pin:'PA5',enable_pin:'!PA6',rotation_distance:'40',microsteps:'16',heater_pin:'aux:PA1',sensor_pin:'aux:PA2',sensor_type:'Generic 3950',min_temp:'0',max_temp:'300',control:'watermark'},
  },[]),null);
  const hardware=await startConfiguredHardware(reader,f.group,f.clocks,{...hardwareLayout,steppers:[...hardwareLayout.steppers,{section:'extruder',emitter:'e',enableLeadTime:.001}]},{beforeTarget(){},motion:[{emitter:'x',queueId:'xyz',mode:'x'},{emitter:'e',queueId:'e',mode:'extruder'}]},f.signal);
  return {...f,hardware};
 }catch(error){await f.close();throw error;}
}
