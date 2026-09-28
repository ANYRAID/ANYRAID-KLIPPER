import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {readDeltaMotionConfiguration} from '../src/config/delta-motion.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
const source={printer:{kinematics:'delta',max_velocity:'300',max_accel:'3000',delta_radius:'100'},stepper_a:{arm_length:'250',position_endstop:'300',rotation_distance:'40',microsteps:'16'},stepper_b:{rotation_distance:'40',microsteps:'16',arm_length:'251',angle:'331',gear_ratio:'2:1'},stepper_c:{rotation_distance:'40',microsteps:'16'}};
const samples:number[]=[];
for(let run=0;run<10;run++){
 const start=performance.now();
 for(let n=0;n<250;n++){
  const reader=new ConfigurationReader(new ConfigurationSource('/delta.cfg',source,[]),null),config=readDeltaMotionConfiguration(reader);
  assert.equal(config.kinematics.status.homedAxes,'');
  for(const [index,rail] of config.rails.entries()){
   using queue=new TrapQueue();queue.appendRaw(new Float64Array([1,0,1,0,0,0,0,0,0,1,10,10,0]));
   using stepper=queue.createStepper({frequency:1e6,timeOffset:0,oid:index,maxError:0,queueStepTag:5,directionTag:6},rail.mode,rail.distance.stepDistance);
   stepper.generate(2);assert.equal(stepper.flush().position,index===1?1600n:800n);
  }
 }
 if(run>=3)samples.push(performance.now()-start);
}
console.log(JSON.stringify({node:process.version,warmups:3,configurationsPerSample:250,nativeSolversPerSample:750,samplesMs:samples,medianMs:[...samples].sort((a,b)=>a-b)[3],scope:'Cold configuration reader, asymmetric Delta geometry, native solver allocation, vertical step generation/count validation and disposal; excludes MCU IO and homing'},null,2));
