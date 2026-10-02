import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BedTilt,fitBedTilt} from '../src/motion/bed-tilt.ts';
import {BedMeshMovePort} from '../src/motion/bed-mesh-port.ts';
import {createGuardedBedMeshPort} from '../src/motion/guarded-bed-mesh-port.ts';
import {motionLimits} from '../src/motion/lookahead.ts';
import {readLinearMotionConfiguration} from '../src/config/linear-motion.ts';
import {readBedTilt} from '../src/config/bed-tilt.ts';
import {linearMotionReader} from './helpers/linear-motion-config.ts';
import {GCodeMove} from '../src/gcode/move.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/bed-tilt-reference.json',import.meta.url),'utf8'));
test('bed tilt preserves original binary64 forward, inverse and least squares arithmetic',()=>{
 for(const r of reference.rows){const tilt=new BedTilt(r.adjust);assert.deepEqual(tilt.apply(r.position),r.forward);assert.deepEqual(tilt.unapply(r.forward),r.inverse);}
 for(const r of reference.fits)assert.deepEqual(fitBedTilt(r.points).adjust,r.adjust);
 assert.throws(()=>fitBedTilt([[0,0,0],[1,1,1],[2,2,2]]),/calculate/);
 assert.throws(()=>new BedTilt({x:NaN,y:0,z:0}));assert.throws(()=>new BedTilt({x:1e308,y:0,z:0}).apply([2,0,0,0]),/overflow/);
});
test('configuration preserves coefficients and rejects competing transform or degenerate probe points',()=>{
 const reader=linearMotionReader({bed_tilt:{x_adjust:'.0123456789012345',points:'0,0\n10,0\n0,10'}}),config=readBedTilt(reader)!;
 assert.equal(config.tilt.adjust.x,.0123456789012345);assert.deepEqual(config.calibration!.points,[[0,0],[10,0],[0,10]]);assert.equal(config.calibration!.horizontalHeight,5);
 assert.throws(()=>readBedTilt(linearMotionReader({bed_tilt:{},bed_mesh:{}})),/same move transform/);
 for(const points of ['0,0\n1,1','0,0\n1,1\n2,2','0,0,0\n1,0\n0,1'])assert.throws(()=>readBedTilt(linearMotionReader({bed_tilt:{points}})));
});
test('G-code tilt applies before physical Z limits and does not alter extrusion or queue on rejection',()=>{
 const config=readLinearMotionConfiguration(linearMotionReader({bed_tilt:{x_adjust:'.1',z_adjust:'.2'}}));config.kinematics.markHomed([0,1,2]);
 const port=createGuardedBedMeshPort({mesh:null,tilt:config.bedTilt,physicalPosition:[0,0,.2,0],limits:config.limits,kinematics:config.kinematics,extrusion:config.extrusion,canExtrude:()=>true}),gcode=new GCodeMove(port);
 gcode.execute('G1',{X:10,E:1,F:600});assert.deepEqual(port.plannedPosition,[10,0,1.2,1]);assert.deepEqual(gcode.state.position,[10,0,0,1]);
 const before=port.pending;assert.throws(()=>gcode.execute('G1',{Z:200}),/range/);assert.equal(port.pending,before);assert.deepEqual(port.plannedPosition,[10,0,1.2,1]);
 const moves=port.flush();assert.equal(moves.length,1);assert.equal(moves[0].axesD[2],1);assert.equal(moves[0].axesD[3],1);
});
test('clearing a mesh preserves the active tilt inverse and no coefficients alias caller state',async()=>{
 const adjust={x:.1,y:0,z:.2},tilt=new BedTilt(adjust);adjust.x=50;
 const port=new BedMeshMovePort({mesh:null,tilt,physicalPosition:[10,0,1.2,0],limits:motionLimits(100,1000),validate:()=>{}});
 assert.deepEqual(port.position(),[10,0,0,0]);assert.deepEqual(await port.replaceMesh(null,{},async()=>{}),[10,0,0,0]);port.move([20,0,0,0],10);assert.equal(port.plannedPosition[2],2.2);
});
