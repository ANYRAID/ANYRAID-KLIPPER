import test from 'node:test';
import assert from 'node:assert/strict';
import {Move,LookAheadQueue,motionLimits} from '../src/motion/lookahead.ts';
import {planPathStop} from '../src/motion/path-stop.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
const limits=motionLimits(100,10,5,0);
function path(endpoints:number[][]){const q=new LookAheadQueue();let start=[0,0,0,0];for(const end of endpoints){q.add(new Move(limits,start,end,10));start=end;}return q.flush();}
test('cruise stop preserves XYZE ratio and replans the unconsumed suffix from rest',()=>{
 const moves=path([[100,0,0,10]]),result=planPathStop(moves,2);
 assert.deepEqual(result.anchor,[15,0,0,1.5]);assert.deepEqual(result.position,[20,0,0,2]);assert.equal(result.velocity,10);assert.equal(result.brake.length,1);
 assert.deepEqual(result.brake[0].profile,{startV:10,cruiseV:10,endV:0,accelT:0,cruiseT:0,decelT:1});
 assert.equal(result.remainder[0].profile,undefined);assert.deepEqual(result.remainder[0].endPos,[100,0,0,10]);
 const q=new LookAheadQueue();q.addBatch(result.remainder);const resumed=q.flush();assert.equal(resumed[0].profile!.startV,0);assert.equal(resumed.at(-1)!.profile!.endV,0);
 moves[0].endPos[0]=999;assert.equal(resumed[0].endPos[0],100);
});
test('braking crosses collinear segments without introducing a junction speed jump',()=>{
 const result=planPathStop(path([[16,0,0,1.6],[100,0,0,10]]),2);
 assert.equal(result.brake.length,2);assert(Math.abs(result.position[0]-20)<1e-12);assert(Math.abs(result.position[3]-2)<1e-12);
 assert.equal(result.brake[0].profile!.endV,result.brake[1].profile!.startV);assert.equal(result.brake.at(-1)!.profile!.endV,0);
});
test('acceleration, deceleration, zero-speed and exact segment boundaries retain coverage',()=>{
 const moves=path([[100,0,0,10]]);
 for(const [time,x,v,stop] of [[0,0,0,0],[.5,1.25,5,2.5],[1,5,10,10],[10.5,98.75,5,100],[11,100,0,100]]){
  const r=planPathStop(moves,time);assert.equal(r.anchor[0],x);assert.equal(r.velocity,v);assert.equal(r.position[0],stop);
 }
 const split=path([[16,0,0,1.6],[100,0,0,10]]),p=split[0].profile!;assert.equal(planPathStop(split,p.accelT+p.cruiseT+p.decelT).anchor[0],16);
});
test('invalid profiles, discontinuity and insufficient braking coverage are rejected without mutation',()=>{
 const moves=path([[16,0,0,1.6],[100,0,0,10]]),before=JSON.stringify(moves);
 assert.throws(()=>planPathStop(moves.slice(0,1),2),/coverage/);assert.equal(JSON.stringify(moves),before);
 for(const t of [-1,NaN,Infinity,100])assert.throws(()=>planPathStop(moves,t));
 moves[1].startPos[0]++;assert.throws(()=>planPathStop(moves,0),/geometry|Discontinuous/);
 const m=path([[100,0,0,10]]);m[0].profile!.decelT=0;assert.throws(()=>planPathStop(m,1),/Invalid planned/);
 const overflow=path([[100,0,0,10]]);overflow[0].axesR[0]=Number.MAX_VALUE;assert.throws(()=>planPathStop(overflow,1),/geometry/);
 const bad=path([[100,0,0,10]]);bad[0].limits.mcrPseudoAccel=NaN;assert.throws(()=>planPathStop(bad,1),/limits/);
 // Fixtures share this limits object; restore it after the deliberate corruption.
 bad[0].limits.mcrPseudoAccel=10;
});
test('deterministic curved paths stop within admitted acceleration and preserve all endpoint geometry',()=>{
 let seed=12345;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
 for(let trial=0;trial<200;trial++){
  const q=new LookAheadQueue();let start=[0,0,0,0];for(let i=0;i<20;i++){const end=[start[0]+1+random()*5,start[1]+(random()-.5)*3,0,start[3]+random()*.2];q.add(new Move(motionLimits(50,1+random()*100),start,end,1+random()*40));start=end;}
  const moves=q.flush(),total=moves.reduce((n,m)=>n+m.profile!.accelT+m.profile!.cruiseT+m.profile!.decelT,0),r=planPathStop(moves,total*random());
  assert(r.brake.length>0);assert.equal(r.brake.at(-1)!.profile!.endV,0);assert.deepEqual(r.remainder.at(-1)?.endPos??r.position,start);
  let previous=r.velocity;
  for(const m of r.brake){const p=m.profile!;assert(Math.abs(previous-p.startV)<1e-10);assert(p.endV<=p.startV);assert.equal(p.accelT,0);assert(Math.abs((p.startV+p.endV)*p.decelT/2+p.cruiseV*p.cruiseT-m.distance)<1e-10);previous=p.endV;}
 }
});
test('integer cruise cases match an independent rational stopping-coordinate oracle',()=>{
 for(let v=1;v<=100;v++)for(let a=1;a<=100;a++){
  const q=new LookAheadQueue();q.add(new Move(motionLimits(100,a,5,0),[0,0,0,0],[20000,0,0,2000],v));const moves=q.flush(),r=planPathStop(moves,moves[0].profile!.accelT+2);
  const numerator=BigInt(v)*BigInt(v)+2n*BigInt(v)*BigInt(a),expected=Number(numerator)/a;
  assert(Math.abs(r.position[0]-expected)<=64*Number.EPSILON*Math.max(1,expected));assert(Math.abs(r.position[3]-expected*.1)<1e-10);
 }
});
test('reverse extrusion-only braking retains the extrusion axis and restart endpoint',()=>{
 const q=new LookAheadQueue(),m=new Move(limits,[0,0,0,10],[0,0,0,-100],10);m.limitSpeed(10,10);q.add(m);const r=planPathStop(q.flush(),2);
 assert.deepEqual(r.anchor,[0,0,0,-5]);assert.deepEqual(r.position,[0,0,0,-10]);assert.equal(r.brake[0].isKinematic,false);assert.equal(r.brake[0].axesR[3],-1);assert.deepEqual(r.remainder[0].endPos,[0,0,0,-100]);
});
test('split brake emits the same native XYZE pulses as a single analytic deceleration',()=>{
 const brake=planPathStop(path([[16,0,0,1.6],[100,0,0,10]]),2).brake;
 function pulses(split:boolean,extrusion:boolean){
  using queue=new TrapQueue();const start=extrusion?1.5:15;queue.setPosition(0,start,0,0);
  using stepper=queue.createStepper({frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6},extrusion?'extruder':'x',.01,[start,0,0]);stepper.initializePosition(0n,0n);
  let end=2;if(split)end=queue.appendPlanned(brake,1,extrusion?3:undefined);else queue.appendRaw(new Float64Array([1,0,0,1,start,0,0,1,0,0,extrusion?1:10,extrusion?1:10,extrusion?1:10]));
  queue.appendRaw(new Float64Array([end,0,.2,0,extrusion?2:20,0,0,0,0,0,0,0,0]));
  stepper.generate(2.1);const out=stepper.flush(),ticks:bigint[]=[];for(let i=0;i<out.history.length;i+=6){const [first,,,count,interval,add]=out.history.slice(i,i+6);for(let j=0n;j<count;j++)ticks.push(first+j*interval+add*j*(j+1n)/2n);}ticks.sort((a,b)=>a<b?-1:a>b?1:0);return {ticks,position:out.position};
 }
 for(const extrusion of [false,true]){const a=pulses(false,extrusion),b=pulses(true,extrusion);assert.equal(b.position,extrusion?50n:500n);assert.equal(a.position,b.position);assert.equal(a.ticks.length,b.ticks.length);for(let i=0;i<a.ticks.length;i++)assert(a.ticks[i]-b.ticks[i]<=1n&&b.ticks[i]-a.ticks[i]<=1n);}
});
