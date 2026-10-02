import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DeltaKinematics,type DeltaConfig} from '../src/kinematics/delta.ts';
import {Move,motionLimits} from '../src/motion/lookahead.ts';
export const deltaConfig:DeltaConfig={radius:100,printRadius:150,arms:[250,250,250],angles:[210,330,90],endstops:[300,300,300],stepDistances:[.01,.01,.01],minimumZ:0,maxVelocity:300,maxAccel:3000,maxZVelocity:20,maxZAccel:200};
const limits=motionLimits(300,3000),move=(start:number[],end:number[])=>new Move(limits,start,end,300);
test('Delta requires all towers homed and clearing any position authority revokes cache',()=>{
 const k=new DeltaKinematics(deltaConfig);assert.throws(()=>k.check(move([0,0,1,0],[1,0,1,0])),/home/);
 k.resetPosition('xy');assert.equal(k.status.homedAxes,'');k.resetPosition('xyz');k.check(move([0,0,1,0],[1,0,1,0]));assert.ok(k.thresholds.cachedXY2>0);
 k.clearHoming();assert.throws(()=>k.check(move([1,0,1,0],[2,0,1,0])),/home/);
});
test('Delta calibration stable coordinates round trip and reject unreachable points',()=>{
 const k=new DeltaKinematics(deltaConfig);
 for(const p of [[0,0,0],[20,-30,100],[-80,40,200]] as [number,number,number][]){const restored=k.positionFromStable(k.stablePosition(p));for(let i=0;i<3;i++)assert.ok(Math.abs(restored[i]-p[i])<1e-10);}
 assert.throws(()=>k.stablePosition([1000,1000,0]));assert.throws(()=>k.calcPosition([NaN,0,0]));
 assert.ok(Math.abs(k.homePosition[2]-300)<1e-10);assert.ok(k.homingMove().force[2]<0);
});
test('Delta radial edge slows to half and quarter while cone and Z bounds reject',()=>{
 const k=new DeltaKinematics(deltaConfig);k.resetPosition('xyz');
 for(const [r,factor] of [[Math.sqrt(k.thresholds.slowXY2)+.1,.5],[Math.sqrt(k.thresholds.verySlowXY2)+.1,.25]]) {
  const m=move([0,0,1,0],[r,0,1,0]);k.check(m);assert.equal(m.maxCruiseV2,(300*factor)**2);assert.equal(m.accel,3000*factor);
 }
 assert.throws(()=>k.check(move([0,0,1,0],[150,0,1,0])),/range/);
 assert.throws(()=>k.check(move([0,0,1,0],[20,0,299,0])),/range/);
 assert.throws(()=>k.check(move([0,0,1,0],[0,0,-.001,0])),/range/);
});

test('Delta probe descent preserves off-center XY, extrusion and Z limits only after full homing',()=>{
 const k=new DeltaKinematics(deltaConfig),start=[25,-30,10,7],end=[25,-30,0,7];
 assert.throws(()=>k.planProbeAxisMove(start,end,100,2),/home/);k.resetPosition('xyz');
 const m=k.planProbeAxisMove(start,end,100,2);assert.deepEqual(m.axesD,[0,0,-10,0]);assert.equal(m.maxCruiseV2,400);assert.equal(m.accel,200);assert.equal(k.status.homedAxes,'xyz');
 assert.throws(()=>k.planHomingAxisMove(start,end,10,2),/homing/);
 for(const target of [[26,-30,0,7],[25,-30,0,8],[25,-30,11,7],[25,-30,-.01,7],[25,-30,NaN,7]])assert.throws(()=>k.planProbeAxisMove(start,target,10,2));
 for(const origin of [[25,-30,299,7],[500,0,10,7]])assert.throws(()=>k.planProbeAxisMove(origin,[origin[0],origin[1],0,7],10,2));
 assert.throws(()=>k.planProbeAxisMove(start,end,10,0));k.clearHoming([1]);assert.throws(()=>k.planProbeAxisMove(start,end,10,2),/home/);
});

test('Delta probe retract raises at fixed bed XY within the envelope',()=>{
 const k=new DeltaKinematics(deltaConfig);k.resetPosition('xyz');
 const move=k.planProbeRetract([25,-30,1,7],[25,-30,3,7],100,2);assert.deepEqual(move.axesD,[0,0,2,0]);assert.equal(move.maxCruiseV2,400);assert.equal(move.accel,200);
 for(const target of [[25,-30,0,7],[26,-30,3,7],[25,-30,299,7],[25,-30,3,8]])assert.throws(()=>k.planProbeRetract([25,-30,1,7],target,10,2));
 k.clearHoming();assert.throws(()=>k.planProbeRetract([25,-30,1,7],[25,-30,3,7],10,2),/home/);
});
