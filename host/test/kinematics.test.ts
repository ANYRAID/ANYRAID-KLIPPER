import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LinearKinematics,KinematicError,type LinearConfig} from '../src/kinematics/linear.ts';
import {Move,motionLimits} from '../src/motion/lookahead.ts';
const config:LinearConfig={kind:'cartesian',ranges:[[0,200],[-10,210],[0,250]],maxVelocity:300,maxAccel:3000,maxZVelocity:10,maxZAccel:100};
const limits=motionLimits(300,3000),move=(start:number[],end:number[])=>new Move(limits,start,end,200);
test('axis homing gates movement, limit updates cannot home and clear revokes permission',()=>{
 const k=new LinearKinematics(config);k.updateLimits(0,[0,100]);assert.equal(k.status.homedAxes,'');
 assert.throws(()=>k.check(move([0,0,0,0],[1,0,0,0])),(e:unknown)=>e instanceof KinematicError&&e.code==='unhomed');
 k.markHomed([0]);k.check(move([0,0,0,0],[200,0,0,0]));assert.throws(()=>k.check(move([0,0,0,0],[200.00000001,0,0,0])),/out of range/);
 k.updateLimits(0,[0,100]);assert.throws(()=>k.check(move([0,0,0,0],[101,0,0,0])));k.clearHoming([0]);assert.equal(k.status.homedAxes,'');
});
test('unchanged unhomed axes and pure extrusion retain original admission semantics',()=>{
 const k=new LinearKinematics(config);k.markHomed([0]);k.check(move([0,0,0,0],[2,0,0,0]));k.check(move([2,0,0,0],[2,0,0,1]));
 assert.throws(()=>k.check(move([2,0,0,0],[2,1,0,0])),/home/);
});
test('diagonal Z motion constrains component speed and acceleration without changing distance',()=>{
 const k=new LinearKinematics(config);k.markHomed([0,1,2]);const m=move([0,0,0,0],[30,40,10,0]),distance=m.distance;k.check(m);
 assert.equal(m.distance,distance);assert.ok(Math.abs(Math.sqrt(m.maxCruiseV2)*Math.abs(m.axesR[2])-10)<1e-12);
 assert.ok(Math.abs(m.accel*Math.abs(m.axesR[2])-100)<1e-12);
 const before=m.maxCruiseV2;assert.throws(()=>k.check(move([0,0,0,0],[30,40,251,0])));assert.equal(m.maxCruiseV2,before);
});
test('CoreXY transforms, homing approach and configuration ownership are explicit',()=>{
 const k=new LinearKinematics({...config,kind:'corexy'});assert.deepEqual(k.calcPosition([30,10,7]),[20,10,7]);
 assert.deepEqual(k.homingMove(0,0,false),{force:[300,null,null,null],home:[0,null,null,null]});
 assert.deepEqual(k.homingMove(2,250,true),{force:[null,null,-125,null],home:[null,null,250,null]});
 const s=k.status;s.axisMaximum[0]=999;assert.equal(k.status.axisMaximum[0],200);
 assert.throws(()=>k.markHomed([0,3 as 0]));assert.equal(k.status.homedAxes,'');
 assert.throws(()=>new LinearKinematics({...config,maxZVelocity:301}));assert.throws(()=>k.calcPosition([Infinity,0,0]));
});
test('hybrid single-carriage position reconstruction retains coupling and linear admission',()=>{
 for(const kind of ['hybrid_corexy','hybrid_corexz'] as const){const k=new LinearKinematics({...config,kind});assert.deepEqual(k.calcPosition([30,10,7]),kind==='hybrid_corexy'?[40,10,7]:[37,10,7]);assert.deepEqual(k.solverModes,kind==='hybrid_corexy'?['corexy-','y','z']:['corexz-','y','z']);
 assert.throws(()=>k.check(move([0,0,0,0],[1,1,1,0])),/home/);k.markHomed([0,1,2]);const m=move([0,0,0,0],[30,40,10,0]);k.check(m);assert(Math.abs(Math.sqrt(m.maxCruiseV2)*Math.abs(m.axesR[2])-10)<1e-12);assert.throws(()=>k.check(move([0,0,0,0],[201,0,0,0])),/range/);
 for(let i=0;i<10000;i++){const x=i/32-100,y=(i%71)/16,z=(i%97)/8,motors=kind==='hybrid_corexy'?[x-y,y,z]:[x-z,y,z];assert.deepEqual(k.calcPosition(motors),[x,y,z]);}
 }
});
