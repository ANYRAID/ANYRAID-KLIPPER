import test from 'node:test';
import assert from 'node:assert/strict';
import {MotanSensorSampler,motanAngleScale} from '../src/motan/sensor-samples.ts';
import type {SensorSelection} from '../src/motan/sensor-samples.ts';
import {sensorCase,sensorOracle} from './helpers/motan-sensor-oracle.ts';
test('Motan sensor interpolation matches actual Python handlers including period-before-interpolation and wide angles',async()=>{
 for(const selection of ['x','y','z','angle','frequency','period','height','force','counts'] as SensorSelection[]){const input=sensorCase(selection),expected=sensorOracle(input);let at=0;const sampler=new MotanSensorSampler(selection,async()=>input.blocks[at++]??null,motanAngleScale(input.settings,'s'));const actual=[];for(const time of input.times)actual.push(await sampler.sample(time));assert.deepEqual(actual,expected.values,selection);}
});
test('angle scale preserves tuple and legacy string gearing, unassociated counts and offset across empty blocks',async()=>{
 assert.equal(motanAngleScale({'angle s':{stepper:'x'},x:{rotation_distance:40,gear_ratio:'1_0:２, 3:1'}},'s'),40*(2/10)*(1/3)/65536);assert.equal(motanAngleScale({},'s'),1);assert.equal(motanAngleScale({'angle s':{stepper:'missing'}},'s'),1/65536);const settings={'angle s':{stepper:'x'},x:{rotation_distance:40,gear_ratio:[[80,20],[3,1]]}};assert.equal(motanAngleScale(settings,'s'),40*(20/80)*(1/3)/65536);assert.throws(()=>motanAngleScale({...settings,x:{gear_ratio:'1:0'}},'s'),/ratio/);assert.throws(()=>motanAngleScale({...settings,x:{gear_ratio:' :2'}},'s'),/number/);
 const input=sensorCase('angle',2);input.settings={};input.blocks=[{data:[],position_offset:3},{data:[[1,10],[2,20]],position_offset:null},{data:[[3,40]],position_offset:5}];input.times=[.5,1,1.5,2,2.5,3,4];const expected=sensorOracle(input);let at=0;const sampler=new MotanSensorSampler('angle',async()=>input.blocks[at++]??null);const actual=[];for(const time of input.times)actual.push(await sampler.sample(time));assert.deepEqual(actual,expected.values);
});
test('sensor samplers reject zero denominators, malformed rows, unsafe integer angles and failed sources permanently',async()=>{
 await assert.rejects(new MotanSensorSampler('x',async()=>null).sample(0),/interval/);await assert.rejects(new MotanSensorSampler('period',async()=>({data:[[1,10,0]]})).sample(.5),/zero frequency/);
 for(const [selection,data] of [['angle',[[1,9007199254740992]]],['x',[[2,1,2,3],[1,1,2,3]]],['x',[[1,Infinity,2,3]]],['force',[[1,2,3]]]] as [SensorSelection,number[][]][]){const sampler=new MotanSensorSampler(selection,async()=>({data}));await assert.rejects(sampler.sample(.5));await assert.rejects(sampler.sample(2));}
 let calls=0;const broken=new MotanSensorSampler('angle',async()=>{calls++;throw new Error('source failed');});await assert.rejects(broken.sample(1),/source failed/);await assert.rejects(broken.sample(2),/source failed/);assert.equal(calls,1);await assert.rejects(new MotanSensorSampler('x',async()=>({data:[]})).sample(1),/block limit/);
});
test('sensor sampler enforces sequential time and concurrency while preserving EOF policy by sensor kind',async()=>{
 let release!:(value:null)=>void;const sampler=new MotanSensorSampler('force',()=>new Promise(resolve=>{release=resolve;}));const pending=sampler.sample(1);await assert.rejects(sampler.sample(1),/sequential/);release(null);assert.equal(await pending,0);await assert.rejects(sampler.sample(.5),/sequential/);
 let sent=false;const angle=new MotanSensorSampler('angle',async()=>sent?null:(sent=true,{data:[[1,100]],position_offset:2}),.5);assert.equal(await angle.sample(2),52);assert.equal(await angle.sample(3),52);
});
test('sensor duplicate timestamps preserve Python endpoint selection and dispatcher fanout can drive independent axes',async()=>{
 const input=sensorCase('x');input.blocks=[{data:[[1,1,2,3],[1,4,5,6],[2,7,8,9]]}];input.times=[.5,1,1,1.5,2,3];const expected=sensorOracle(input);let at=0;const sampler=new MotanSensorSampler('x',async()=>input.blocks[at++]??null);const actual=[];for(const time of input.times)actual.push(await sampler.sample(time));assert.deepEqual(actual,expected.values);
 const {MotanDispatcher}=await import('../src/motan/dispatch.ts');let delivered=false;const dispatch=new MotanDispatcher({pullMessage:async()=>delivered?null:(delivered=true,{q:'accelerometer:s',params:{data:[[1,2,4,6],[2,4,8,12]]}})});dispatch.addHandler('x','accelerometer:s');dispatch.addHandler('y','accelerometer:s');const x=new MotanSensorSampler('x',async time=>(await dispatch.pull(time,'x')) as unknown as import('../src/motan/sensor-samples.ts').SensorBlock|null),y=new MotanSensorSampler('y',async time=>(await dispatch.pull(time,'y')) as unknown as import('../src/motan/sensor-samples.ts').SensorBlock|null);assert.equal(await x.sample(1.5),3);assert.equal(await y.sample(1.5),6);assert.equal(await x.sample(3),0);assert.equal(await y.sample(3),0);assert.equal(dispatch.status.endOfData,true);dispatch.close();
});
