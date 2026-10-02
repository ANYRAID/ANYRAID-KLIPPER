import test from 'node:test';
import assert from 'node:assert/strict';
import {readQuadGantry} from '../src/config/quad-gantry.ts';
import {linearMotionReader} from './helpers/linear-motion-config.ts';
const geometry={gantry_corners:'0,0\n50,100',points:'0,0\n0,100\n50,100\n50,0'};
const reader=(patch:Record<string,Record<string,string>>={})=>linearMotionReader({probe:{z_offset:'0'},stepper_z1:{},stepper_z2:{},stepper_z3:{},quad_gantry_level:geometry,...patch});
test('configured gantry binds four ordered motors and validates full geometry',()=>{
 const plan=readQuadGantry(reader())!;assert.deepEqual(plan.motorIds,['z','z1','z2','z3']);assert.equal(plan.maximumTravel,4);assert.equal(plan.retries,0);assert(Object.isFrozen(plan.corners[0]));assert.equal(readQuadGantry(linearMotionReader()),undefined);
 for(const patch of [{max_adjust:'0'},{points:'0,0\n0,100\n50,100\n50,1'},{gantry_corners:'0,0'},{points:'0,0\n0,100\n53,100\n53,0'},{retries:'31'},{unknown:'1'}] as Record<string,string>[])assert.throws(()=>readQuadGantry(reader({quad_gantry_level:{...geometry,...patch}})));
 for(const extra of [{stepper_z4:{}},{z_tilt:{}},{bed_tilt:{}},{printer:{kinematics:'corexz'}}] as Record<string,Record<string,string>>[])assert.throws(()=>readQuadGantry(reader(extra)));
});
