import test from 'node:test';
import {encodeFrame} from '../src/protocol/codec.ts';
import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {StepCompressor,type StepperKinematics} from '../src/motion/step-compressor.ts';
import {endstopRestTime,homingEndstopSampling} from '../src/homing/endstop-rate.ts';
import {recoveryFixture} from './helpers/homing-recovery.ts';
const settings={frequency:1e6,timeOffset:0,oid:1,maxError:0,queueStepTag:5,directionTag:6};
test('native coordinate projection preserves solver state for all supported kinematics',()=>{
 const xyz:[number,number,number]=[3,4,5],modes:[StepperKinematics,number][]=[['x',3],['y',4],['z',5],['corexy+',7],['corexy-',-1],['corexz+',8],['corexz-',-2],['extruder',3],[{kind:'delta',armLength:100,towerX:0,towerY:0},Math.sqrt(10000-25)+5]];
 for(const [mode,expected] of modes){using q=new TrapQueue();using s=q.createStepper(settings,mode,.01);const position=s.commandedPosition,generated=s.generatedTime,calibration=s.calibration;assert.equal(s.coordinatePosition(...xyz),expected);assert.equal(s.commandedPosition,position);assert.equal(s.generatedTime,generated);assert.deepEqual(s.calibration,calibration);assert.throws(()=>s.coordinatePosition(NaN,0,0));assert.equal(s.commandedPosition,position);}
});
test('endstop rate follows fastest coupled actuator and preserves zero-step fallback',()=>{
 using q=new TrapQueue();using a=q.createStepper(settings,'corexy+',.01);using b=q.createStepper({...settings,oid:2},'corexy-',.02);
 const actuators=[{stepper:a,stepDistance:.01},{stepper:b,stepDistance:.02}];
 assert.equal(endstopRestTime([0,0,0],[3,4,0],10,actuators),.5/700);
 assert.equal(endstopRestTime([3,4,0],[0,0,0],10,actuators),.5/700);
 assert.equal(endstopRestTime([0,0,0],[0,0,2],10,actuators),.001);
 assert.throws(()=>endstopRestTime([0,0,0],[1,0,0],0,actuators));assert.throws(()=>endstopRestTime([0,0,0],[1,0,0],1,[actuators[0],actuators[0]]));
});
test('native projection rejects missing, closed and unreachable solvers without mutation',()=>{
 using plain=new StepCompressor(settings);assert.throws(()=>plain.coordinatePosition(0,0,0),/solver/);
 using q=new TrapQueue();const s=q.createStepper(settings,{kind:'delta',armLength:100,towerX:0,towerY:0},.01);const before=s.commandedPosition;assert.throws(()=>s.coordinatePosition(101,0,0),/Unreachable/);assert.equal(s.commandedPosition,before);s.dispose();assert.throws(()=>s.coordinatePosition(0,0,0));
});
test('sampling uses native rest rate and standard debounce without issuing firmware writes',async()=>{
 const f=await recoveryFixture(1);try{const s=f.options.bindings[0].stepper,before=f.fs[0].outputs.length;const sampling=homingEndstopSampling(f.options.endstop,s,8,2,[0,0,0],[3,0,0],10,[{stepper:s,stepDistance:.01}]);assert.equal(sampling.restTicks,1000n);assert.equal(sampling.reqClock,2000000n);const decoded=f.sessions[0].dictionary.parseFrame(encodeFrame(0,sampling.payload));assert.equal(decoded[0].parameters.sample_ticks,15);assert.equal(decoded[0].parameters.sample_count,4);assert.equal(f.fs[0].outputs.length,before);}finally{await f.close();}
});
