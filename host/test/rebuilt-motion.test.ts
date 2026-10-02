import test from 'node:test';
import assert from 'node:assert/strict';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {rebuiltFixture} from './helpers/rebuilt-motion.ts';
import {BedMeshMovePort} from '../src/motion/bed-mesh-port.ts';
import {motionLimits} from '../src/motion/lookahead.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
test('actual coordinate recovery binds XYZ and extrusion, retains integer history and drains MCU time',async()=>{
 const f=await rebuiltFixture();try{
  const bound=await bindRebuiltMotion(f.options),port=new BedMeshMovePort({mesh:null,physicalPosition:f.options.position,limits:motionLimits(100,1000),validate:()=>{}});
  port.move([51,0,0,2.1],10);await bound.source.drain(port.flush(),new AbortController().signal);
  const [x,e]=bound.motion.bindings;
  assert.equal(x.history.status.lastPlannedPosition,200n);assert.equal(e.history.status.lastPlannedPosition,30n);
  assert.equal(x.history.at(x.history.status.throughClock),200n);assert.equal(e.history.at(e.history.status.throughClock),30n);
  assert.equal(f.fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===3).reduce((sum,m)=>sum+Number(m.parameters.count),0),100);
  assert.equal(f.fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===4).reduce((sum,m)=>sum+Number(m.parameters.count),0),10);
  assert.equal(bound.source.status.paused,true);assert.deepEqual(bound.source.status.position,[51,0,0,2.1]);
  assert(f.options.group.session('m').clock.sync.lastClock>x.stepper.clockAt(bound.coordinator.status.committedTime));
  await bound.coordinator.retire(new AbortController().signal);assert.equal(f.stops,0);
 }finally{await f.close();}
});
test('rebuilt source route failure closes the group and disposes transferred native handles',async()=>{
 const f=await rebuiltFixture();try{
  await assert.rejects(bindRebuiltMotion({...f.options,routes:[f.options.routes[0]]}),/ownership|requires|coverage/);
  assert.equal(f.stops,1);assert.equal(f.options.group.status.state,'stopped');assert.throws(()=>f.options.motion.bindings[0].stepper.calibration,/closed/);
 }finally{await f.close();}
});
test('expired rebase baseline cannot acquire a usable motion source',async()=>{
 const f=await rebuiltFixture();try{
  const clock=f.options.members[0].session.clock.sync;
  while(clock.getClock(serialClock.now())<=f.options.motion.bindings[0].stepper.clockAt(f.options.motion.printTime))await new Promise(r=>setTimeout(r,10));
  await assert.rejects(bindRebuiltMotion(f.options),/baseline expired/);assert.equal(f.stops,1);
 }finally{await f.close();}
});
test('rebuilt binding requires every physical member and consistent shared MCU clocks',async()=>{
 for(const mismatch of [false,true]){const f=await rebuiltFixture();try{
  if(mismatch)f.options.motion.bindings[1].stepper.calibrateClock(0,1000001);
  await assert.rejects(bindRebuiltMotion({...f.options,members:mismatch?f.options.members:[]}),/every physical MCU|clocks differ/);assert.equal(f.stops,1);
 }finally{await f.close();}}
});

test('source coordinate and physical stepper identity cannot diverge from recovered metadata',async()=>{
 for(const coordinate of [false,true]){const f=await rebuiltFixture();try{
  const options=coordinate?{...f.options,position:[51,0,0,2]}:{...f.options,members:f.options.members.map(m=>({...m,steppers:[{oid:2,inverted:false},{oid:4,inverted:false}]}))};
  await assert.rejects(bindRebuiltMotion(options),/coordinate differs|Incomplete/);assert.equal(f.stops,1);
 }finally{await f.close();}}
});
