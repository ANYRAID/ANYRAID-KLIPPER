import test from 'node:test';
import assert from 'node:assert/strict';
import {idleMotionFixture,idleTestMove} from './helpers/idle-motion.ts';
const signal=()=>new AbortController().signal;
for(const gap of [3600,86400,604800])for(const filtered of [false,true])test(`idle source advances once without steps (seconds=${gap}, filtered=${filtered})`,async()=>{
 const f=idleMotionFixture(filtered);try{
  f.source.startAt(gap);assert.equal(await f.source.prepareIdle(signal()),true);assert.equal(f.commits,1);assert.deepEqual(f.positions,{x:100n,e:20n});assert.equal(f.ticks.x.length+f.ticks.e.length,0);
  f.source.append(idleTestMove());const before=f.coordinator.status;assert.equal(await f.source.prepareIdle(signal()),false);assert.deepEqual(f.coordinator.status,before);
  await f.source.drain([],signal());assert.deepEqual(f.positions,{x:200n,e:30n});assert.equal(f.stops,0);
 }finally{f.close();}
});
test('idle preparation after full drain retains counters across another hour and resumes',async()=>{
 const f=idleMotionFixture(true);try{
  f.source.startAt(1);await f.source.prepareIdle(signal());await f.source.drain(idleTestMove(50,51,2),signal());const steps=f.ticks.x.length+f.ticks.e.length,commits=f.commits;
  f.source.resumeAt(3601);await f.source.prepareIdle(signal());assert.equal(f.commits,commits+1);assert.equal(f.ticks.x.length+f.ticks.e.length,steps);assert.deepEqual(f.positions,{x:200n,e:20n});
  await f.source.drain(idleTestMove(51,52,2),signal());assert.deepEqual(f.positions,{x:300n,e:20n});assert.equal(f.stops,0);
 }finally{f.close();}
});
test('misdeclared XYZ or E movement fails before any idle batch can be committed',async()=>{
 for(const extrusion of [false,true]){const f=idleMotionFixture();try{
  f.source.startAt(.1);f.source.append(extrusion?idleTestMove(50,50,3):idleTestMove(50,51,2));
  await assert.rejects(f.coordinator.advanceIdleSource(f.source.status.sourceTime),/Idle advance contains step motion/);assert.equal(f.commits,0);assert.equal(f.stops,1);assert.equal(f.coordinator.status.failed,true);
 }finally{f.close();}}
});
