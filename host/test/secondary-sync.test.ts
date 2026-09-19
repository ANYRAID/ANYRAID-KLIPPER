import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ClockSync} from '../src/timing/clock-sync.ts';
import {SecondarySync} from '../src/timing/secondary-sync.ts';
const accept={calibrateClock(){}};
function clocks(){return {main:new ClockSync(1e6,1000000n,10),local:new ClockSync(2e6,10000000n,10)};}
test('secondary mapping aligns different MCU origins and frequencies',()=>{
 const {main,local}=clocks(),s=new SecondarySync(main,local,10);
 assert.equal(s.printTimeToClock(1),10000000n);assert.equal(s.clockToPrintTime(10000000n),1);
 const p=s.propose(1.5,10.1);s.apply(p,accept,['secondary']);assert(Math.abs(s.mapping.frequency-2e6)<1e-6);assert.equal(s.printTimeToClock(2),12000000n);
});
test('rejected motion calibration leaves estimator mapping and horizon unchanged',()=>{
 const {main,local}=clocks(),s=new SecondarySync(main,local,10),before=s.mapping,p=s.propose(2,10.5);
 assert.throws(()=>s.apply(p,{calibrateClock(){throw new Error('in-flight batch');}},['e']),/in-flight/);assert.deepEqual(s.mapping,before);
 s.apply(p,accept,['e']);assert.throws(()=>s.apply(p,accept,['e']),/Stale/);
});
test('clock samples invalidate proposals and foreign or edited proposals cannot apply',()=>{
 const {main,local}=clocks(),s=new SecondarySync(main,local,10),p=s.propose(2,10.5);
 assert.throws(()=>s.apply({...p},accept,['e']),/foreign/);assert(Object.isFrozen(p));
 local.accept({clock32:12000000,sentTime:11,receiveTime:11.002},true);assert.throws(()=>s.apply(p,accept,['e']),/Stale/);
 const fresh=s.propose(2,11);s.apply(fresh,accept,['e']);
});
test('inactive clocks and unrepresentable native ranges fail without changing the active mapping',()=>{
 const {main,local}=clocks(),s=new SecondarySync(main,local,10),before=s.mapping;
 for(let i=0;i<5;i++)local.querySent();assert.throws(()=>s.propose(2,11),/inactive/);assert.deepEqual(s.mapping,before);
 assert.throws(()=>new SecondarySync(main,new ClockSync(1e6,2n**60n,10),10),/exact/);assert.throws(()=>s.printTimeToClock(-1));
});
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
test('secondary estimate applies to a live coordinated stepper without changing its endpoint',async()=>{
 const {main,local}=clocks(),sync=new SecondarySync(main,local,10),initial=sync.mapping;
 using q=new TrapQueue();q.setPosition(1,0,0,0);q.appendRaw(new Float64Array([1.1,0,1,0,0,0,0,1,0,0,1,1,0]));
 using s=q.createStepper({frequency:initial.frequency,timeOffset:initial.offset,initialClock:10000000n,oid:3,maxError:0,queueStepTag:5,directionTag:6},'x',.01);
 const c=new MotionCoordinator([{id:'x',queue:q,stepper:s}],{async commit(){},async stop(){assert.fail('unexpected stop');}},16*1024*1024,1);
 await c.advanceWindow(1.6,1.55);
 main.accept({clock32:1400000,sentTime:10.4,receiveTime:10.402},true);local.accept({clock32:10799920,sentTime:10.4,receiveTime:10.402},true);
 const p=sync.propose(1.6,10.405);sync.apply(p,c,['x']);assert.deepEqual(sync.mapping,p);
 assert.equal(s.clockAt(2),BigInt(Math.floor((2-p.offset)*p.frequency+.5)));
 await c.advanceWindow(2.1,2.05);await c.advance(2.1);assert(Math.abs(s.generate(2.1)-1)<1e-9);assert.equal(s.flush().position,100n);
});
