import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GCodeMove,type Parameters} from '../src/gcode/move.ts';
function setup() {
  let position=[0,0,0,0];const moves:{position:number[];speed:number}[]=[];
  const engine=new GCodeMove({position:()=>position,move:(p,speed)=>{position=[...p];moves.push({position,speed});}});
  return {engine,moves};
}
test('absolute and relative axes retain upstream M82/G91 interaction',()=>{
  const {engine,moves}=setup();
  engine.execute('G1',{X:10,E:2,F:1200});engine.execute('G91');engine.execute('M82');engine.execute('G1',{X:2,E:1});
  assert.deepEqual(moves.at(-1),{position:[12,0,0,3],speed:20});
  engine.execute('G90');engine.execute('M83');engine.execute('G1',{X:1,E:2});
  assert.deepEqual(engine.state.position,[1,0,0,5]);
});
test('speed and extrusion overrides preserve logical coordinates',()=>{
  const {engine}=setup();engine.execute('G1',{E:10,F:1200});engine.execute('M221',{S:200});
  assert.equal(engine.gcodePosition[3],10);engine.execute('G1',{E:11});assert.equal(engine.state.position[3],12);
  engine.execute('M220',{S:50});assert.equal(engine.state.speed,10);engine.execute('G92',{E:0});assert.equal(engine.gcodePosition[3],0);
});
test('save/restore returns XYZ without replaying extrusion or losing relative E origin',()=>{
  const {engine,moves}=setup();engine.execute('G1',{X:10,E:2});engine.execute('SAVE_GCODE_STATE',{NAME:'pause'});
  engine.execute('G91');engine.execute('G1',{X:5,E:3});engine.execute('RESTORE_GCODE_STATE',{NAME:'pause',MOVE:1,MOVE_SPEED:5});
  assert.deepEqual(moves.at(-1),{position:[10,0,0,5],speed:5});assert.equal(engine.gcodePosition[3],2);
  assert.equal(engine.state.absoluteCoordinates,true);
});
test('offset adjustments optionally move and invalid inputs have no side effects',()=>{
  const {engine,moves}=setup();engine.execute('SET_GCODE_OFFSET',{Z:2});assert.equal(moves.length,0);
  engine.execute('G1',{Z:1});assert.equal(engine.state.position[2],3);
  engine.execute('SET_GCODE_OFFSET',{Z_ADJUST:.5,MOVE:1});assert.equal(engine.state.position[2],3.5);
  const before=engine.state,count=moves.length;
  const invalid:Parameters[]=[{X:2,F:0},{X:NaN},{X:'1oops'},{E:Infinity}];
  for(const params of invalid)assert.throws(()=>engine.execute('G1',params));
  assert.deepEqual(engine.state,before);assert.equal(moves.length,count);
});
test('rejected move admission does not advance coordinate state',()=>{
  const engine=new GCodeMove({position:()=>[0,0,0,0],move:()=>{throw new Error('Not homed');}});
  assert.throws(()=>engine.execute('G1',{X:10}),/Not homed/);assert.deepEqual(engine.state.position,[0,0,0,0]);
});

import {Move,LookAheadQueue,motionLimits} from '../src/motion/lookahead.ts';
import {ExtrusionGuard} from '../src/motion/extrusion.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {LinearKinematics} from '../src/kinematics/linear.ts';
test('coordinate commands feed lookahead and actual XYZ/extruder C queues consistently',()=>{
  const guard=new ExtrusionGuard({nozzleDiameter:.4,filamentDiameter:1.75,maxCrossSection:.64,maxVelocity:25,maxAccel:500,maxDistance:50,instantCornerVelocity:1});
  const limits={...motionLimits(100,1000),extraAxes:[(a:Move,b:Move,index:number)=>guard.junction(a,b,index)]};
  const lookahead=new LookAheadQueue();let position=[0,0,0,0];
  const kinematics=new LinearKinematics({kind:'cartesian',ranges:[[0,200],[0,200],[0,200]],maxVelocity:100,maxAccel:1000,maxZVelocity:10,maxZAccel:100});
  kinematics.markHomed([0,1,2]); // Simulated completion; no physical endstop attached.
  const engine=new GCodeMove({position:()=>position,move:(target,speed)=>{
    const move=new Move(limits,position,target,speed);kinematics.check(move);guard.check(move,3,true);lookahead.add(move);position=[...move.endPos];
  }});
  engine.execute('G1',{X:10,E:1,F:600});engine.execute('G91');engine.execute('G1',{Y:10,E:1});
  engine.execute('G90');engine.execute('G92',{E:0});engine.execute('G1',{X:20,E:1});
  const moves=lookahead.flush(),xyz=new TrapQueue(),extruder=new TrapQueue();
  try {
    const end=xyz.appendPlanned(moves,1);assert.equal(extruder.appendPlanned(moves,1,3),end);
    const p=xyz.extract(1,0,end+1),e=extruder.extract(1,0,end+1);
    const distance=(p[2]+.5*p[3]*p[1])*p[1];
    assert.deepEqual([p[4]+p[7]*distance,p[5]+p[8]*distance,p[6]+p[9]*distance],[20,10,0]);
    assert.ok(Math.abs(e[4]+(e[2]+.5*e[3]*e[1])*e[1]-3)<1e-12);
  } finally {xyz.dispose();extruder.dispose();}
});
