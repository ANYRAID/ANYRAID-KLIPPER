import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Move,LookAheadQueue,motionLimits} from '../src/motion/lookahead.ts';
const limits=motionLimits(300,3000);
function check(move:Move):void {
  const p=move.profile!;
  assert.ok(p&&Object.values(p).every(v=>Number.isFinite(v)&&v>=0));
  const distance=(p.startV+p.cruiseV)*.5*p.accelT+p.cruiseV*p.cruiseT+(p.endV+p.cruiseV)*.5*p.decelT;
  assert.ok(Math.abs(distance-move.distance)<1e-10*Math.max(1,move.distance));
  assert.ok(p.cruiseV**2<=move.maxCruiseV2+1e-8);
}
test('single move trapezoid starts and ends at rest with exact integrated distance',()=>{
  for(const distance of [1e-8,.001,1,100,1000]) {
    const q=new LookAheadQueue(),m=new Move(limits,[0,0,0,0],[distance,0,0,0],200);q.add(m);
    assert.deepEqual(q.flush(),[m]);check(m);assert.equal(m.profile!.startV,0);assert.equal(m.profile!.endV,0);
  }
});
test('straight junctions preserve speed, reversal stops and square corner limits apply',()=>{
  for(const [end,max] of [[[20,0,0,0],200],[[10,10,0,0],5],[[0,0,0,0],0]] as const) {
    const q=new LookAheadQueue(),a=new Move(limits,[0,0,0,0],[10,0,0,0],200),b=new Move(limits,a.endPos,end,200);
    q.add(a);q.add(b);q.flush();check(a);check(b);
    assert.ok(a.profile!.endV<=max+1e-10);assert.equal(a.profile!.endV,b.profile!.startV);
    if(max===200) assert.ok(a.profile!.endV>5);
  }
});
test('zero moves are omitted, extrusion-only moves use explicit axis limits',()=>{
  const q=new LookAheadQueue();q.add(new Move(limits,[0,0,0,0],[0,0,0,0],100));assert.equal(q.length,0);
  const m=new Move(limits,[0,0,0,0],[0,0,0,10],100);m.limitSpeed(25,500);q.add(m);q.flush();check(m);
  assert.equal(m.isKinematic,false);assert.ok(m.profile!.cruiseV<=25);
});
test('extra-axis limits and explicit next-junction limits are applied',()=>{
  const config={...limits,extraAxes:[()=>4]};
  const a=new Move(config,[0,0,0,0],[20,0,0,0],100),b=new Move(config,a.endPos,[40,0,0,1],100);
  a.limitNextJunctionSpeed(1);const q=new LookAheadQueue();q.add(a);q.add(b);q.flush();assert.equal(b.profile!.startV,1);
});
test('lazy flush retains unfinished tail and final flush preserves velocity continuity',()=>{
  const q=new LookAheadQueue(),output:Move[]=[];let start=[0,0,0,0];
  for(let i=1;i<=300;i++) {
    const end=[i*.1,Math.sin(i*.1),0,0],m=new Move(limits,start,end,100);
    if(q.add(m)) output.push(...q.flush(true));start=end;
  }
  output.push(...q.flush());assert.equal(output.length,300);assert.equal(q.length,0);
  output.forEach(check);
  for(let i=1;i<output.length;i++) assert.ok(Math.abs(output[i-1].profile!.endV-output[i].profile!.startV)<1e-8);
});
test('invalid and overflow inputs fail before planning',()=>{
  for(const speed of [0,-1,NaN,Infinity]) assert.throws(()=>new Move(limits,[0,0,0,0],[1,0,0,0],speed));
  assert.throws(()=>new Move(limits,[0,0,0,0],[1e308,0,0,0],1));
  assert.throws(()=>motionLimits(100,1000,5,1));
  const m=new Move(limits,[0,0,0,0],[1,0,0,0],100);
  assert.throws(()=>m.setJunction(0,10000,0));
});

import {ExtrusionGuard} from '../src/motion/extrusion.ts';
const extrusion=new ExtrusionGuard({nozzleDiameter:.4,filamentDiameter:1.75,maxCrossSection:.64,maxVelocity:25,maxAccel:500,maxDistance:50,instantCornerVelocity:1});
test('extrusion admission rejects cold, oversized and excess-ratio moves before queueing',()=>{
  const m=new Move(limits,[0,0,0,0],[10,0,0,1],100);
  assert.throws(()=>extrusion.check(m,3,false),/minimum temperature/);
  assert.doesNotThrow(()=>extrusion.check(m,3,true));
  assert.throws(()=>extrusion.check(new Move(limits,[0,0,0,0],[1,0,0,10],100),3,true),/maximum extrusion/);
  assert.throws(()=>extrusion.check(new Move(limits,[0,0,0,0],[0,0,0,51],100),3,true),/too long/);
  const tiny=new Move(limits,[0,0,0,0],[.001,0,0,.01],100);assert.doesNotThrow(()=>extrusion.check(tiny,3,true));
  const retract=new Move(limits,[0,0,0,0],[10,0,0,-10],100);extrusion.check(retract,3,true);
  assert.equal(retract.maxCruiseV2,625);assert.equal(retract.accel,500);
});
test('extrusion ratio changes constrain the shared lookahead junction',()=>{
  const config={...limits,extraAxes:[(a:Move,b:Move,index:number)=>extrusion.junction(a,b,index)]};
  const a=new Move(config,[0,0,0,0],[10,0,0,0],100),b=new Move(config,a.endPos,[20,0,0,2],100);
  extrusion.check(b,3,true);
  const q=new LookAheadQueue();q.add(a);q.add(b);q.flush();
  assert.ok(b.profile!.startV<=5+1e-10);check(a);check(b);
});
test('distance preserves compensated-sum rounding used by the Python 3.12 oracle',()=>{
  const move=new Move(limits,[0,0,0,0],[1.01,.001,.0003,0],100);
  assert.equal(move.distance,1.0100005396038163);
});
