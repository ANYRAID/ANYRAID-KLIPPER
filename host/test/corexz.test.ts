import test from 'node:test';
import assert from 'node:assert/strict';
import {LinearKinematics} from '../src/kinematics/linear.ts';
import {Move,motionLimits} from '../src/motion/lookahead.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {inputShaper} from '../src/motion/shaper.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
const rows=new Float64Array([
 1,.125,.75,.125,0,0,0,1,0,0,0,8,64,
 2,0,.5,0,7,0,0,0,0,1,6,6,0,
 2.5,.125,.75,.125,7,0,3,.6,0,-.8,0,8,64,
 3.5,.125,.75,.125,11.2,0,-2.6,-1,0,0,0,8,64,
 4.5,0,.2,0,4.2,0,-2.6,0,0,0,0,0,0,
]);
function run(corexz:boolean,minus:boolean,shaped:boolean,chunked:boolean){
 const moves=new Float64Array(rows);if(!corexz)for(let i=0;i<moves.length;i+=13){[moves[i+5],moves[i+6]]=[moves[i+6],moves[i+5]];[moves[i+8],moves[i+9]]=[moves[i+9],moves[i+8]];}
 using queue=new TrapQueue();queue.appendRaw(moves);
 using stepper=queue.createStepper(settings,corexz?(minus?'corexz-':'corexz+'):(minus?'corexy-':'corexy+'),.01);
 if(shaped)stepper.configureShapers({x:inputShaper('zvd',70,.1),[corexz?'z':'y']:inputShaper('mzv',45,.1)});
 for(const time of chunked?[1.03,1.11,1.7,2.01,2.3,2.7,3.2,3.9,4.6]:[4.6])stepper.generate(time);
 return stepper.flush();
}
test('CoreXZ packets, clocks and signed step histories match original CoreXY solver under axis permutation',()=>{
 for(const shaped of [false,true])for(const minus of [false,true]){
  const reference=run(false,minus,shaped,false),whole=run(true,minus,shaped,false),chunked=run(true,minus,shaped,true);
  assert.deepEqual(whole,reference);assert.deepEqual(chunked,reference);assert.equal(whole.position,minus?680n:160n);
  assert.ok(whole.messages.length>0);assert.ok(whole.history.length>0);
 }
});
test('CoreXZ initial coordinates and Z-only direction affect both actuators, while Y-only motion does not',()=>{
 for(const yOnly of [false,true]){
  using queue=new TrapQueue();queue.appendRaw(new Float64Array([1,0,1,0,5,7,3,0,yOnly?1:0,yOnly?0:1,1,1,0]));
  using plus=queue.createStepper(settings,'corexz+',.01,[5,7,3]),minus=queue.createStepper({...settings,oid:4},'corexz-',.01,[5,7,3]);
  assert.ok(Math.abs(plus.generate(2)-(yOnly?8:9))<1e-10);assert.ok(Math.abs(minus.generate(2)-(yOnly?2:1))<1e-10);
  assert.equal(plus.flush().position,yOnly?0n:100n);assert.equal(minus.flush().position,yOnly?0n:-100n);
 }
});
test('CoreXZ Z contribution is included in both generation capacity and MCU clock resolution guards',()=>{
 for(const [duration,speed,distance,error]of [[1,1,.000001,/budget/],[.01,6000,.01,/clock resolution/]] as const){
  using queue=new TrapQueue();queue.appendRaw(new Float64Array([1,0,duration,0,0,0,0,0,0,1,speed,speed,0]));
  for(const mode of ['corexz+','corexz-'] as const){using stepper=queue.createStepper(settings,mode,distance);assert.throws(()=>stepper.generate(1+duration),error);assert.equal(stepper.flush().position,0n);}
 }
});
test('CoreXZ inverse coordinates, homing authority and Z component admission use the original geometry',()=>{
 const k=new LinearKinematics({kind:'corexz',ranges:[[0,200],[0,200],[0,250]],maxVelocity:300,maxAccel:3000,maxZVelocity:10,maxZAccel:100});
 assert.deepEqual(k.calcPosition([30,7,10]),[20,7,10]);
 const limits=motionLimits(300,3000);assert.throws(()=>k.check(new Move(limits,[0,0,0,0],[1,0,0,0],200)),/home/);
 k.markHomed([0,1]);assert.throws(()=>k.check(new Move(limits,[0,0,0,0],[0,0,1,0],200)),/home/);k.markHomed([2]);
 const move=new Move(limits,[0,0,0,0],[30,40,10,0],200);k.check(move);assert.ok(Math.abs(Math.sqrt(move.maxCruiseV2)*move.axesR[2]-10)<1e-12);
 assert.deepEqual(k.homingMove(2,250,true),{force:[null,null,-125,null],home:[null,null,250,null]});
 k.clearHoming([0]);assert.equal(k.status.homedAxes,'yz');assert.throws(()=>k.check(new Move(limits,[0,0,0,0],[1,0,0,0],200)),/home/);
 assert.throws(()=>k.calcPosition([Number.MAX_VALUE,0,Number.MAX_VALUE]),/overflow/);
});
