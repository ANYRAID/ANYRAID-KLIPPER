import test from 'node:test';
import assert from 'node:assert/strict';
import {readZTilt} from '../src/config/z-tilt.ts';
import {linearMotionReader} from './helpers/linear-motion-config.ts';
const section={z_positions:'0,0\n50,0',points:'0,0\n50,0'};
const reader=(extra:Record<string,Record<string,string>>={})=>linearMotionReader({probe:{z_offset:'1'},stepper_z1:{},z_tilt:section,...extra});
test('Z tilt reads configured probe geometry, bounded retries and stable numeric motor ordering',()=>{
 const p=readZTilt(reader())!;assert.deepEqual(p.motors,[{id:'z',x:0,y:0},{id:'z1',x:50,y:0}]);assert.equal(p.maximumTravel,5);assert.equal(p.retries,0);assert.equal(p.retryTolerance,0);assert(Object.isFrozen(p)&&Object.isFrozen(p.points[0]));
 const ordered=readZTilt(reader({stepper_z10:{},stepper_z2:{},z_tilt:{...section,z_positions:'0,0\n10,0\n20,0\n30,0',retries:'4',retry_tolerance:'.002',max_adjust:'.5'}}))!;assert.deepEqual(ordered.motors.map(m=>m.id),['z','z1','z2','z10']);assert.equal(ordered.maximumTravel,.5);
 assert.equal(readZTilt(linearMotionReader()),undefined);
});
test('Z tilt refuses unsupported topology, unknown options, unsafe travel and invalid fit before startup',()=>{
 for(const patch of ([{max_adjust:'0'},{retries:'31'},{retry_tolerance:'1.01'},{horizontal_move_z:'0'},{horizontal_move_z:'201'},{points:'0,0\n53,0'},{z_positions:'0,0'},{points:'0,0\n0,10'},{unknown:'1'}] as Record<string,string>[]))assert.throws(()=>readZTilt(reader({z_tilt:{...section,...patch}})));
 assert.throws(()=>readZTilt(reader({printer:{kinematics:'corexz'}})),/independent/);assert.throws(()=>readZTilt(reader({bed_tilt:{}})),/bed_tilt/);
 assert.throws(()=>readZTilt(linearMotionReader({stepper_z1:{},z_tilt:section})),/probe/);
});
