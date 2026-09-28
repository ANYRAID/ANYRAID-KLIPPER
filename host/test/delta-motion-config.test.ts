import test from 'node:test';
import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {readDeltaMotionConfiguration} from '../src/config/delta-motion.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
function reader(overrides:Record<string,Record<string,string>>={}){
 const base:Record<string,Record<string,string>>={printer:{kinematics:'delta',max_velocity:'300',max_accel:'3000',delta_radius:'100'},stepper_a:{arm_length:'250',position_endstop:'300',rotation_distance:'40',microsteps:'16'},stepper_b:{rotation_distance:'40',microsteps:'16'},stepper_c:{rotation_distance:'40',microsteps:'16'}};
 for(const [section,values] of Object.entries(overrides))base[section]={...base[section],...values};
 return new ConfigurationReader(new ConfigurationSource('/delta.cfg',base,[]),null);
}
test('Delta configuration inherits A arm/endstop while retaining independent tower geometry and step distance',()=>{
 const config=readDeltaMotionConfiguration(reader({stepper_b:{arm_length:'251',angle:'331',position_endstop:'301',gear_ratio:'2:1'}}));
 assert.deepEqual(config.rails.map(r=>r.armLength),[250,251,250]);assert.deepEqual(config.rails.map(r=>r.homing.endstop),[300,301,300]);
 assert.deepEqual(config.rails.map(r=>r.distance.stepDistance),[.0125,.00625,.0125]);assert.deepEqual(config.rails.map(r=>r.angle),[210,331,90]);
 assert.equal(config.kinematics.status.homedAxes,'');assert.ok(Object.isFrozen(config.rails));assert.ok(Object.isFrozen(config.rails[0].mode));
 assert.deepEqual(config.rails.map(r=>r.mode),config.kinematics.solverGeometry);
});
test('configured Delta geometry feeds native tower solvers with exact vertical step counts',()=>{
 const config=readDeltaMotionConfiguration(reader({stepper_b:{arm_length:'251',angle:'331',position_endstop:'301',gear_ratio:'2:1'}}));
 for(const [index,rail] of config.rails.entries()){
  using queue=new TrapQueue();queue.appendRaw(new Float64Array([1,0,1,0,0,0,0,0,0,1,10,10,0]));
  using stepper=queue.createStepper({frequency:1e6,timeOffset:0,oid:index,maxError:0,queueStepTag:5,directionTag:6},rail.mode,rail.distance.stepDistance);
  const height=stepper.generate(2);assert.ok(Math.abs(height-(Math.sqrt(rail.armLength**2-100**2)+10))<1e-10);
  assert.equal(stepper.flush().position,BigInt(Math.round(10/rail.distance.stepDistance)));
 }
});
test('Delta config rejects invalid geometry, travel and unrepresentable limits before native allocation',()=>{
 const changes:Record<string,Record<string,string>>[]=[{printer:{delta_radius:'250'}},{printer:{minimum_z_position:'301'}},{printer:{max_z_velocity:'301'}},{stepper_b:{position_endstop:'-1'}},{stepper_a:{homing_positive_dir:'false'}},{stepper_b:{arm_length:'99'}},{stepper_c:{microsteps:'0'}},{stepper_a:{homing_speed:'5e-324'}},{printer:{max_velocity:'1e308'}}];
 for(const change of changes)assert.throws(()=>readDeltaMotionConfiguration(reader(change)),JSON.stringify(change));
});
