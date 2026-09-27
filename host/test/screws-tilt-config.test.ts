import test from 'node:test';
import assert from 'node:assert/strict';
import {readScrewsTilt} from '../src/config/screws-tilt.ts';
import {linearMotionReader} from './helpers/linear-motion-config.ts';
const screws={screw1:'10,10',screw2:'20,10',screw3:'10,20',screw1_name:'front',screw_thread:'CCW-M4'};
test('screw configuration owns bounded consecutive coordinates and validates physical ranges',()=>{
 const read=(options:Record<string,string>)=>readScrewsTilt(linearMotionReader({probe:{pin:'PA1',z_offset:'0'},screws_tilt_adjust:options}));
 const plan=read(screws)!;assert.deepEqual(plan.points,[[10,10],[20,10],[10,20]]);assert.equal(plan.names[0],'front');assert.equal(plan.thread,'CCW-M4');assert.equal(plan.horizontalHeight,5);assert(Object.isFrozen(plan.points[0]));
 for(const extra of ([{screw2:'53,10'},{screw4_name:'orphan'},{horizontal_move_z:'201'},{speed:'0'},{screw_thread:'CW-M7'},{screw1:'1,2,3'}] as Record<string,string>[]))assert.throws(()=>read({...screws,...extra}));
 assert.equal(readScrewsTilt(linearMotionReader({screws_tilt_adjust:screws}))!.points.length,3);
});
