import test from 'node:test';
import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {readDeltaCalibrationPlan} from '../src/config/delta-calibration-plan.ts';
const reader=(values:Record<string,string>,kind='delta')=>new ConfigurationReader(new ConfigurationSource('/plan.cfg',{printer:{kinematics:kind},delta_calibrate:values},[]),null);
test('Delta calibration defaults preserve staggered radii and nozzle travel coordinates',()=>{
 const p=readDeltaCalibrationPlan(reader({radius:'65'}))!;
 assert.equal(p.points.length,7);assert.deepEqual(p.points[0],[0,0]);assert.equal(p.horizontalHeight,5);assert.equal(p.travelSpeed,50);
 [.95,.90,.85,.70,.75,.80].forEach((v,i)=>assert(Math.abs(Math.hypot(...p.points[i+1])-65*v)<1e-12));assert(Object.isFrozen(p.points[1]));
 for(const options of ([{radius:'0'},{radius:'65',points:'0,0\n1,1\n2,2'},{radius:'65',speed:'0'}] as Record<string,string>[]))assert.throws(()=>readDeltaCalibrationPlan(reader(options)));
 assert.throws(()=>readDeltaCalibrationPlan(reader({radius:'65'},'cartesian')));
});
