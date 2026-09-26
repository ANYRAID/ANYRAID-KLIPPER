import test from 'node:test';
import assert from 'node:assert/strict';
import {Move,motionLimits} from '../src/motion/lookahead.ts';
import {representableProfile} from '../src/motion/representable-profile.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
function move(start:number,end:number,a:number,b:number){const m=new Move(motionLimits(100,1000),[start,0,0,0],[end,0,0,0],10);m.setJunction(a,100,b);return m;}
for(const [start,end,a,b,time] of [[3.78,3.79,100,80.00000000000007,3.1993729999999587],[3.88,3.89,99.99999999999964,100,4.667461912383371],[9.95,9.96,100,79.9999999999983,3.619281999999901]])test(`clock representation preserves endpoints and speeds for ${start} -> ${end}`,()=>{
 const m=move(start,end,a,b),before=structuredClone(m.profile!),p=representableProfile(m,time)!;
 assert.ok(p);assert.deepEqual(m.profile,before);assert.equal(p.startV,before.startV);assert.equal(p.endV,before.endV);assert(p.accel<=m.accel);assert.equal(p.cruiseT,0);
 const duration=p.accelT+p.decelT;assert.equal(time+duration,((time+before.accelT)+before.cruiseT)+before.decelT);
 const sign=p.accelT?1:-1;assert.equal(start+(p.startV+.5*sign*p.accel*duration)*duration,end);assert.equal(p.startV+sign*p.accel*duration,p.endV);
 using queue=new TrapQueue();assert.equal(queue.appendPlanned([m],time),time+duration);
 const extracted=queue.extract(10,time,time+duration+1);assert.equal(extracted.length,10);assert.equal(extracted[4]+(extracted[2]+.5*extracted[3]*extracted[1])*extracted[1],end);
 // Actual compressed motor count: one short segment is eight 0.00125 mm steps.
 using motor=queue.createStepper({frequency:1e6,timeOffset:0,maxError:0,queueStepTag:5,directionTag:6,oid:3},'x',.00125,[start,0,0]);
 motor.generate(time+duration);assert.equal(motor.flush().position,8n);
});
test('representable real phases, unbounded long-clock distortion remain protected',()=>{
 const m=move(3.78,3.79,100,80.00000000000007);assert.equal(representableProfile(m,0),undefined);
 const real=move(0,.01,100,90);assert.equal(representableProfile(real,1),undefined);assert.equal(representableProfile(real,1e14),undefined);
 using queue=new TrapQueue();assert.throws(()=>queue.appendPlanned([real],1e14),/time resolution/);assert.equal(queue.extract(10,0,1e14+1).length,0);
});
test('coalescing respects reversed coordinates and synchronized extrusion endpoints',()=>{
 for(const sign of [-1,1])for(const extrusion of [false,true]){
  const start=[sign*3.78,0,0,extrusion?.378:0],end=[sign*3.79,0,0,extrusion?.379:0];
  const m=new Move(motionLimits(100,1000),start,end,10);m.setJunction(100,100,80.00000000000007);const time=3.1993729999999587,p=representableProfile(m,time);
  assert.ok(p);
  using xyz=new TrapQueue();using e=new TrapQueue();const until=xyz.appendPlanned([m],time);assert.equal(e.appendPlanned([m],time,3,true),until);
  for(const [queue,coordinate] of [[xyz,0],[e,3]] as const){const r=queue.extract(1,time,until+1);if(coordinate===3&&!extrusion){assert.equal(r.length,0);continue;}assert.equal(r[4]+r[7]*(r[2]+.5*r[3]*r[1])*r[1],end[coordinate]);}
 }
});
