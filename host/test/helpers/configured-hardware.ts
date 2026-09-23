import {ConfigurationReader} from '../../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../../src/moonraker/config-source.ts';
import type {HardwareLayout} from '../../src/config/hardware.ts';
import type {MCUGroup} from '../../src/runtime/mcu-group.ts';
import {stepperBatchFixture} from './configured-steppers.ts';
export const hardwareLayout:HardwareLayout={steppers:[{section:'stepper_x',emitter:'x',enableLeadTime:.001}],homing:[{section:'stepper_x',mcus:['mcu','aux']}],fans:[{section:'fan',minimumScheduleTime:.001}],heaters:[{section:'extruder'}],boards:[{mcu:'mcu',aliases:{STEP:'PA0'}}]};
export const hardwareClocks=()=>new Map(['mcu','aux'].map(id=>[id,{currentPrintTime:1,calibration:{offset:0,frequency:1e6}}]));
export function hardwareReader(fanPin='aux:PA0'){
 return new ConfigurationReader(new ConfigurationSource('/hardware.cfg',{
  stepper_x:{step_pin:'STEP',dir_pin:'PA1',rotation_distance:'40',microsteps:'16',enable_pin:'!PA2',endstop_pin:'^PA3'},
  fan:{pin:fanPin,enable_pin:'aux:PA3'},
  extruder:{heater_pin:'aux:PA1',sensor_pin:'aux:PA2',sensor_type:'Generic 3950',min_temp:'0',max_temp:'300',control:'watermark'},
 },[]),null);
}
export function hardwareFixture(){
 const {dictionary}=stepperBatchFixture(),sessions=new Map(['mcu','aux'].map(id=>[id,{dictionary,status:{configured:false}}]));
 const group={assertActive(){},status:{devices:[{id:'mcu'},{id:'aux'}]},session(id:string){const s=sessions.get(id);if(!s)throw new Error('Unknown MCU');return s;}} as unknown as MCUGroup;
 return {group,sessions};
}
