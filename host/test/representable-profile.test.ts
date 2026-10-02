import test from 'node:test';
import assert from 'node:assert/strict';
import {Move,LookAheadQueue,motionLimits} from '../src/motion/lookahead.ts';
import {representableProfile} from '../src/motion/representable-profile.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
test('sub-clock two-ramp plateau has bounded geometry and preserves reference motor counts',()=>{
 for(const sign of [-1,1])for(const extruder of [false,true]){
  const axis=extruder?3:0,start=[0,0,0,0],end=[0,0,0,0];start[axis]=sign*2.05;end[axis]=sign*2.06;
  const m=new Move(motionLimits(100,100),start,end,1);m.accel=100;m.setJunction(0,1,0);const original=structuredClone(m.profile!),time=4.969021999999999,p=representableProfile(m,time)!;
  assert(p);assert.equal(p.cruiseT,0);assert.equal(p.accelT,original.accelT);assert.equal(p.decelT,original.decelT);assert.equal(p.accel,100);assert.equal(p.cruiseV,original.cruiseV);assert.deepEqual(m.profile,original);assert.equal(representableProfile(m,0),undefined);
  const counts:bigint[]=[];
  for(const t of [0,time]){
   using queue=new TrapQueue();const until=queue.appendPlanned([m],t,extruder?3:undefined);
   using motor=queue.createStepper({frequency:1e6,timeOffset:0,maxError:0,queueStepTag:5,directionTag:6,oid:3},'x',.00125,[start[axis],0,0]);motor.generate(until);counts.push(motor.flush().position);
   const row=queue.extract(1,t,until+1);const integrated=row[4]+row[7]*(row[2]+.5*row[3]*row[1])*row[1];assert(Math.abs(integrated-end[axis])<=Number.EPSILON*4);
  }
  assert.deepEqual(counts,[BigInt(sign*8),BigInt(sign*8)]);
 }
 // A coarse clock cannot authorize meaningful cruise removal.
 const large=new Move(motionLimits(100,100),[1e6,0,0,0],[1e6+.010001,0,0,0],1);large.setJunction(0,1,0);assert.equal(representableProfile(large,1e14),undefined);
});
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
 using queue=new TrapQueue();assert.throws(()=>queue.appendPlanned([real],1e14),error=>{assert(error instanceof RangeError);const detail=JSON.parse(error.message.slice(error.message.indexOf(': ')+2));assert.equal(detail.row[0],1e14);assert.equal(detail.row.length,13);assert.equal(detail.extrusionAxis,null);assert.equal(detail.replace,false);assert(detail.phase>=1&&detail.phase<=3);return true;});assert.equal(queue.extract(10,0,1e14+1).length,0);
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
test('clock and extrusion rounding plateaus admit an exact interior duration',()=>{
 const m=new Move(motionLimits(100,1000),[9.95,0,0,.995],[9.96,0,0,.996],10);m.setJunction(100,100,79.9999999999983);
 const time=2.999999999999901,original=structuredClone(m.profile!),p=representableProfile(m,time);assert(p);assert.equal(original.cruiseT,7.095019016745141e-17);
 assert.equal(time+p.decelT,time+original.cruiseT+original.decelT);assert.equal(p.startV-p.accel*p.decelT,p.endV);assert(p.accel<=m.accel);assert.deepEqual(m.profile,original);
 for(const axis of [undefined,3]){
  using q=new TrapQueue();const until=q.appendPlanned([m],time,axis),start=axis===3?.995:9.95,end=axis===3?.996:9.96;
  const row=q.extract(1,time,until+1);assert.equal(row[4]+(row[2]+.5*row[3]*row[1])*row[1],end);
  using motor=q.createStepper({frequency:1e6,timeOffset:0,maxError:0,queueStepTag:5,directionTag:6,oid:3},'x',axis===3?.000125:.00125,[start,0,0]);motor.generate(until);assert.equal(motor.flush().position,8n);
 }
});
test('product path remains representable across absolute clock boundaries and batch sizes',()=>{
 for(const chunk of [10,150,1000]){
  const q=new LookAheadQueue(),moves:Move[]=[];
  for(let i=0;i<1000;i++){q.add(new Move(motionLimits(100,1000),[i/100,0,0,i/1000],[(i+1)/100,0,0,(i+1)/1000],10));if((i+1)%chunk===0)moves.push(...q.flush(true));}moves.push(...q.flush());
  for(const start of [1,2,4,8,16,32,64]){
   using xyz=new TrapQueue();using e=new TrapQueue();const end=xyz.appendPlanned(moves,start);assert.equal(e.appendPlanned(moves,start,3,true),end);
   for(const [queue,position] of [[xyz,10],[e,1]] as const){const r=queue.extract(1,start,end+1);assert.equal(r[4]+r[7]*(r[2]+.5*r[3]*r[1])*r[1],position);}
  }
 }
});

test('two-sided triangular junctions do not invent sub-clock cruise from distance cancellation',()=>{
 const start=[3,1,2,.1],end=[3.00046,1.00020102,2.00000046,.1000046],m=new Move(motionLimits(100,1000),start,end,10),a=40.046,b=41.023,peak=(a+(b+m.deltaV2))*.5;
 const residual=m.distance-(peak-a)*(.5/m.accel)-(peak-b)*(.5/m.accel);assert(residual>0);assert(residual/Math.sqrt(peak)<Number.EPSILON);
 m.setJunction(a,peak,b);assert.equal(m.profile!.cruiseT,0);assert(m.profile!.accelT>0&&m.profile!.decelT>0);assert.equal(m.profile!.startV,Math.sqrt(a));assert.equal(m.profile!.endV,Math.sqrt(b));
 for(const time of [1,12.037322595289076,32,1024]){
  using xyz=new TrapQueue();using e=new TrapQueue();const until=xyz.appendPlanned([m],time);assert.equal(e.appendPlanned([m],time,3,true),until);
  for(const [q,indices] of [[xyz,[0,1,2]],[e,[3]]] as const){const r=q.extract(1,time,until+1),distance=(r[2]+.5*r[3]*r[1])*r[1];for(const [j,i] of indices.entries())assert(Math.abs(r[4+j]+r[7+j]*distance-end[i])<=Number.EPSILON*Math.abs(end[i]));}
 }
 // A genuinely speed-capped trapezoid still retains its nonzero cruise.
 const capped=new Move(motionLimits(100,1000),start,end,10);capped.setJunction(a,(peak+b)*.5,b);assert(capped.profile!.cruiseT>0);
});

test('rounded triangular identities do not discard resolvable motion or pure cruise',()=>{
 for(const distance of [1e-9,.0025]){
  const m=new Move(motionLimits(1e9,1000),[0,0,0,0],[distance,0,0,0],1e9),v2=1e16,peak=(v2+(v2+m.deltaV2))*.5;
  m.setJunction(v2,peak,v2);assert(m.profile!.cruiseT>0);
 }
});
test('captured second-tool sub-clock ramp borrows cruise with exact endpoints and native counts',()=>{
 const m=new Move(motionLimits(100,1000),[5.05,0,0,.5,.0050000000000000044],[5.06,0,0,.5,.006000000000000005],10);
 m.profile={startV:9.999999999999982,cruiseV:10,endV:10,accelT:1.776356839400252e-17,cruiseT:.000999999999999961,decelT:0};
 const time=12.165165;assert.equal(time+m.profile.accelT,time);const p=representableProfile(m,time)!;assert(p);assert.equal(p.accel,10);assert.equal(p.startV,m.profile.startV);assert.equal(p.endV,m.profile.endV);assert.equal(time+p.accelT+p.cruiseT,time+m.profile.accelT+m.profile.cruiseT);
 for(const axis of [undefined,4]){
  const counts:bigint[]=[];
  for(const t of [0,time]){
   using q=new TrapQueue();const until=q.appendPlanned([m],t,axis),coordinate=axis??0;
   using motor=q.createStepper({frequency:1e6,timeOffset:0,maxError:0,queueStepTag:5,directionTag:6,oid:3},'x',axis===4?.000125:.00125,[m.startPos[coordinate],0,0]);motor.generate(until);counts.push(motor.flush().position);
   const rows=q.extract(10,t,until+1),row=rows.subarray(0,10);assert.equal(row[4]+row[7]*(row[2]+.5*row[3]*row[1])*row[1],m.endPos[coordinate]);
  }
  assert.deepEqual(counts,[8n,8n]);
 }
});
test('second-tool sub-clock cruise uses monotone-ramp deviation bound with exact native endpoints',()=>{
 const m=new Move(motionLimits(100,1000),[9.95,0,0,.5,.495],[9.96,0,0,.5,.496],10);m.setJunction(100,100,79.9999999999983);
 const time=12.806810385087,p=representableProfile(m,time);assert(p);assert.equal(p.startV,m.profile!.startV);assert.equal(p.endV,m.profile!.endV);assert(p.accel<=m.accel);
 for(const axis of [undefined,4]){
  const counts:bigint[]=[];
  for(const t of [0,time]){using q=new TrapQueue();const until=q.appendPlanned([m],t,axis),coordinate=axis??0;using motor=q.createStepper({frequency:1e6,timeOffset:0,maxError:0,queueStepTag:5,directionTag:6,oid:3},'x',axis===4?.000125:.00125,[m.startPos[coordinate],0,0]);motor.generate(until);counts.push(motor.flush().position);const row=q.extract(1,t,until+1);assert.equal(row[4]+row[7]*((row[2]+.5*row[3]*row[1])*row[1]),m.endPos[coordinate]);}
  assert.deepEqual(counts,[8n,8n]);
 }
});
test('borrowed ramp keeps signed multi-axis native endpoints across clock scales',()=>{
 for(const sign of [-1,1])for(const time of [8,16,32]){
  const m=new Move(motionLimits(100,1000),[sign*5.05,0,0,.5,sign*.0050000000000000044],[sign*5.06,0,0,.5,sign*.006000000000000005],10);
  m.profile={startV:9.999999999999982,cruiseV:10,endV:10,accelT:1.776356839400252e-17,cruiseT:.000999999999999961,decelT:0};const p=representableProfile(m,time);assert(p);
  for(const axis of [undefined,4]){using q=new TrapQueue();const until=q.appendPlanned([m],time,axis),i=axis??0;assert.equal(until,time+m.profile.accelT+m.profile.cruiseT);const row=q.extract(1,time,until+1);assert.equal(row[4]+row[7]*((row[2]+.5*row[3]*row[1])*row[1]),m.endPos[i]);using motor=q.createStepper({frequency:1e6,timeOffset:0,maxError:0,queueStepTag:5,directionTag:6,oid:3},'x',axis===4?.000125:.00125,[m.startPos[i],0,0]);motor.generate(until);assert.equal(motor.flush().position,BigInt(sign*8));}
 }
});
