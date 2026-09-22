import test from 'node:test';
import assert from 'node:assert/strict';
import {MotanPhaseSampler,motanPhaseConfig} from '../src/motan/phase-samples.ts';
import {phaseOracle,phaseStatus,phaseSettings} from './helpers/motan-phase-oracle.ts';
import {motionCase} from './helpers/motan-motion-oracle.ts';
test('full phase and microstep sampling matches Python with wide signed positions, offsets, reversal and EOF',async()=>{
 for(const microstep of [false,true]){const input=motionCase(1200),expected=phaseOracle(input.blocks,input.times,microstep);let at=0;const sampler=new MotanPhaseSampler(motanPhaseConfig(phaseSettings,'tmc2209 stepper_x',microstep?'microstep':'phase'),async()=>input.blocks[at++]??null,phaseStatus),values=[];for(const time of input.times)values.push(await sampler.sample(time));assert.deepEqual(values,expected.values);}
});
test('phase configuration preserves driver whitespace split and rejects incomplete or inexact configuration',()=>{
 assert.equal(motanPhaseConfig({'tmc2209\u0085stepper_x':{},stepper_x:{microsteps:16}},'tmc2209\u0085stepper_x').phases,64);assert.throws(()=>motanPhaseConfig({},'tmc2209 stepper_x'),/Missing/);assert.throws(()=>motanPhaseConfig({...phaseSettings,stepper_x:{microsteps:0}},'tmc2209 stepper_x'),/microsteps/);
});
test('phase selection preserves exact step endpoints and skips obsolete blocks like Python',async()=>{
 const input=motionCase(3);input.times=[0,1,1.2,1.4,1.8,2.5,3,3.8,9,10];const expected=phaseOracle(input.blocks,input.times);let at=0;const sampler=new MotanPhaseSampler(motanPhaseConfig(phaseSettings,'tmc2209 stepper_x'),async()=>input.blocks[at++]??null,phaseStatus),values=[];for(const time of input.times)values.push(await sampler.sample(time));assert.deepEqual(values,expected.values);
});
test('phase sampler rejects unsafe offsets, concurrent/backwards calls, unbounded source and expansion',async()=>{
 const config=motanPhaseConfig(phaseSettings,'tmc2209 stepper_x'),bad=new MotanPhaseSampler(config,async()=>null,async()=>({status:{'tmc2209 stepper_x':{mcu_phase_offset:9007199254740992}},nextTime:2}));await assert.rejects(bad.sample(1),/exact integer/);await assert.rejects(bad.sample(2),/exact integer/);
 const block=motionCase(3).blocks[0];await assert.rejects(new MotanPhaseSampler(config,async()=>block,phaseStatus,2).sample(1),/step limit/);await assert.rejects(new MotanPhaseSampler(config,async()=>block,phaseStatus).sample(100),/block limit/);
 let release!:(value:null)=>void;const sampler=new MotanPhaseSampler(config,()=>new Promise(resolve=>{release=resolve;}),phaseStatus),pending=sampler.sample(1);await assert.rejects(sampler.sample(1),/sequential/);release(null);await pending;await assert.rejects(sampler.sample(0),/sequential/);
});
test('phase sampler combines dispatcher step blocks with timestamped driver state changes',async()=>{
 const {MotanDispatcher,MotanStatusTracker}=await import('../src/motan/dispatch.ts');const first=9007199254740993n,block={first_clock:first,last_clock:first+100n,first_step_time:1,last_step_time:2,start_mcu_position:first,start_position:0,step_distance:.01,data:[[100,2,0]] as [number,number,number][]},messages=[{q:'status',params:{status:{toolhead:{estimated_print_time:0},'tmc2209 stepper_x':{mcu_phase_offset:0}}}},{q:'stepq:stepper_x',params:block},{q:'status',params:{status:{toolhead:{estimated_print_time:1.5},'tmc2209 stepper_x':{mcu_phase_offset:3}}}},{q:'status',params:{status:{toolhead:{estimated_print_time:3},'tmc2209 stepper_x':{mcu_phase_offset:null}}}}];let at=0;const dispatch=new MotanDispatcher({pullMessage:async()=>messages[at++]??null});dispatch.addHandler('status','status');dispatch.addHandler('phase','stepq:stepper_x');const tracker=new MotanStatusTracker({},time=>dispatch.pull(time,'status')),sampler=new MotanPhaseSampler(motanPhaseConfig(phaseSettings,'tmc2209 stepper_x'),async time=>(await dispatch.pull(time,'phase')) as unknown as typeof block|null,time=>tracker.sample(time));const values=[];for(const time of [0,1,1.5,2,3])values.push(await sampler.sample(time));assert.deepEqual(values,[1,2,5,6,3]);assert.equal(dispatch.status.endOfData,true);dispatch.close();
});
test('phase zero-count blocks terminate safely and explicit null driver state fails instead of hiding corruption',async()=>{
 const config=motanPhaseConfig(phaseSettings,'tmc2209 stepper_x'),block={...motionCase(1).blocks[0],start_mcu_position:9n,data:[[0,0,0]] as [number,number,number][]};let sent=false;const sampler=new MotanPhaseSampler(config,async()=>sent?null:(sent=true,block),async()=>({status:{},nextTime:10}));assert.equal(await sampler.sample(1),9);await assert.rejects(new MotanPhaseSampler(config,async()=>null,async()=>({status:{'tmc2209 stepper_x':null},nextTime:10})).sample(1),/object/);
});
