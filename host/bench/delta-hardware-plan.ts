import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {planDeltaHardware} from '../src/config/delta-printer.ts';
const source={printer:{kinematics:'delta',max_velocity:'300',max_accel:'3000',delta_radius:'100'},stepper_a:{arm_length:'250',position_endstop:'300',rotation_distance:'40',microsteps:'16',step_pin:'PA0',dir_pin:'PA1',endstop_pin:'PA2'},stepper_b:{rotation_distance:'40',microsteps:'16',step_pin:'aux:PA0',dir_pin:'aux:PA1',endstop_pin:'aux:PA2'},stepper_c:{rotation_distance:'40',microsteps:'16',step_pin:'PA3',dir_pin:'PA4',endstop_pin:'PA5'},extruder:{step_pin:'PA6',dir_pin:'PA7'}};
const samples:number[]=[];
for(let run=0;run<10;run++){
 const start=performance.now();
 for(let n=0;n<1000;n++){
  const reader=new ConfigurationReader(new ConfigurationSource('/delta.cfg',source,[]),null),p=planDeltaHardware(reader,{mcus:['mcu','aux'],enableLeadTime:.001,fanMinimumScheduleTime:.001});
  assert.deepEqual(p.homing.map(g=>g.emitters),[['a','e'],['b'],['c']]);assert.equal(p.config.kinematics.status.homedAxes,'');
 }
 if(run>=3)samples.push(performance.now()-start);
}
console.log(JSON.stringify({node:process.version,warmups:3,configurationsPerSample:1000,samplesMs:samples,medianMs:[...samples].sort((a,b)=>a-b)[3],scope:'Cold Delta hardware planning and ownership validation only; excludes native allocation, MCU IO, homing and print throughput'},null,2));
