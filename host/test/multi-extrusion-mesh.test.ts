import test from 'node:test';
import assert from 'node:assert/strict';
import {createMultiExtrusionMeshPort,createMultiExtrusionValidator,createGuardedBedMeshPort} from '../src/motion/guarded-bed-mesh-port.ts';
import {BedMesh} from '../src/motion/bed-mesh.ts';
import {BedTilt} from '../src/motion/bed-tilt.ts';
import {SkewCorrection} from '../src/motion/skew.ts';
import {splitBedMeshMove} from '../src/motion/bed-mesh-split.ts';
import {LinearKinematics} from '../src/kinematics/linear.ts';
import {ExtrusionGuard} from '../src/motion/extrusion.ts';
import {motionLimits,Move} from '../src/motion/lookahead.ts';
function setup(){const kinematics=new LinearKinematics({kind:'cartesian',ranges:[[0,200],[0,200],[0,200]],maxVelocity:300,maxAccel:3000,maxZVelocity:20,maxZAccel:200});kinematics.markHomed([0,1,2]);const guard=(velocity:number)=>new ExtrusionGuard({nozzleDiameter:.4,filamentDiameter:1.75,maxCrossSection:.64,maxVelocity:velocity,maxAccel:500,maxDistance:50,instantCornerVelocity:1});return {kinematics,extruders:[{extrusion:guard(25),canExtrude:()=>true},{extrusion:guard(5),canExtrude:()=>true}],mesh:new BedMesh({min_x:0,max_x:20,min_y:0,max_y:20,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct',tension:.2},[[0,.2],[0,.2]]),physicalPosition:[0,0,0,0,0],limits:motionLimits(300,3000)};}
test('mesh interpolation preserves every filament axis at all endpoints, including short and stationary XY',()=>{
 const mesh={calcZ:(x:number)=>x*.01};
 const moves=splitBedMeshMove(mesh,[0,0,0,0,8,-2],[20,0,0,4,0,-2]);assert.equal(moves.length,4);
 moves.forEach((p,i)=>assert.deepEqual(p,[5*(i+1),0,[.05,.1,.15,.2][i],i+1,8-2*(i+1),-2]));
 assert.deepEqual(splitBedMeshMove(mesh,[0,0,0,0,8],[1,0,0,2,3]),[[1,0,.01,2,3]]);
 assert.deepEqual(splitBedMeshMove(mesh,[0,0,0,0,8],[0,0,0,2,3]),[[0,0,0,2,3]]);
 assert.throws(()=>splitBedMeshMove(mesh,[0,0,0,0],[0,0,0,0,1]),/input/);
});
test('each moving extruder requires its own live heat permission; late failure publishes no segments',()=>{
 const o=setup();let calls=0;o.extruders[1].canExtrude=()=>++calls<3;const p=createMultiExtrusionMeshPort(o);
 assert.throws(()=>p.move([20,0,0,.1,.2],100),/temperature/);assert.equal(calls,3);assert.equal(p.pending,0);assert.deepEqual(p.plannedPosition,o.physicalPosition);
 // Cold inactive second extruder does not block the first.
 p.move([20,0,0,.1,0],100);assert(p.flush().length>1);assert.equal(calls,3);
});
test('secondary extrusion cannot bypass distance, flow, velocity or junction limits',()=>{
 const o=setup(),p=createMultiExtrusionMeshPort({...o,mesh:null});
 assert.throws(()=>p.move([0,0,0,0,51],100),/too long/);assert.throws(()=>p.move([20,0,0,0,100],100),/maximum extrusion/);
 p.move([0,0,0,1,2],100);const moves=p.flush();assert.equal(moves[0].maxCruiseV2,25);assert.deepEqual(moves[0].endPos,[0,0,0,1,2]);
 p.move([10,0,0,1,2],100);p.move([20,0,0,1,3],100);const corner=p.flush();assert(corner[1].maxStartV2<=100);
});
test('skew and tilt preserve all extruder coordinates and invert the XYZ transform',()=>{
 const original=[16,8,4,-2,3,17],skew=new SkewCorrection({xy:.125,xz:.25,yz:.125}),tilt=new BedTilt({x:.125,y:.25,z:.5});
 for(const transform of [skew,tilt]){const p=transform.apply(original);assert.deepEqual(p.slice(3),original.slice(3));assert.deepEqual(transform.unapply(p),original);}
 const o=setup(),p=createMultiExtrusionMeshPort({...o,mesh:null,skew,tilt});p.move([16,8,4,.1,.2],50);assert.deepEqual(p.position(),[16,8,4,.1,.2]);assert.deepEqual(p.flush().at(-1)!.endPos.slice(3),[.1,.2]);
});
test('ownership mismatch and asynchronous or truthy thermal permissions fail closed on admission and resume',async()=>{
 const o=setup();assert.throws(()=>createGuardedBedMeshPort({...o,extrusion:o.extruders[0].extrusion,canExtrude:()=>true}),/XYZE/);
 assert.throws(()=>createMultiExtrusionMeshPort({...o,extruders:o.extruders.slice(0,1)}),/ownership/);
 assert.throws(()=>createMultiExtrusionMeshPort({...o,extruders:[o.extruders[0],{...o.extruders[1],canExtrude:async()=>true} as any]}),/synchronous/);
 const policies=[...o.extruders],p=createMultiExtrusionMeshPort({...o,extruders:policies});policies.pop();p.move([10,0,0,.1,.1],50);assert.equal(p.flush().at(-1)!.endPos.length,5);
 const validate=createMultiExtrusionValidator(o.kinematics,[o.extruders[0],{...o.extruders[1],canExtrude:(()=>Promise.reject(Error('late'))) as any}]);
 assert.throws(()=>validate(new Move(o.limits,[0,0,0,0,0],[0,0,0,0,1],5)),/temperature/);
 assert.throws(()=>validate(new Move(o.limits,[0,0,0,0],[0,0,0,1],5)),/ownership/);
 await new Promise(r=>setImmediate(r));
});
