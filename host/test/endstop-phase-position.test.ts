import test from 'node:test';
import assert from 'node:assert/strict';
import {LinearKinematics,type Axis} from '../src/kinematics/linear.ts';
import {endstopPhasePosition} from '../src/homing/endstop-phase-position.ts';
test('phase correction follows coupled motor signs and preserves unselected axes',()=>{
 for(const kind of ['cartesian','corexy','corexz','hybrid_corexy','hybrid_corexz'] as const){
  const kin=new LinearKinematics({kind,ranges:[[0,200],[0,200],[0,200]],maxVelocity:100,maxAccel:1000,maxZVelocity:5,maxZAccel:100});
  const position=[10,20,30,4],actuators=kind==='cartesian'?[10,20,30]:kind==='corexy'?[30,-10,30]:kind==='corexz'?[40,20,-20]:kind==='hybrid_corexy'?[-10,20,30]:[-20,20,30];
  const deltas=kind==='cartesian'?[.5,.5,.5]:kind==='corexy'?[.25,-.25,.5]:kind==='corexz'?[.25,.5,-.25]:[.5,.5,.5];
  for(const axis of [0,1,2] as Axis[]){const expected=[...position];expected[axis]+=deltas[axis];assert.deepEqual(endstopPhasePosition(kin,position,actuators,axis,.5),expected);}
  assert.deepEqual(position,[10,20,30,4]);
 }
});
