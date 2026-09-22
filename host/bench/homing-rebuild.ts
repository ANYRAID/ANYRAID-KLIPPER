import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {StepperPosition} from '../src/motion/stepper-position.ts';
import {StepHistory} from '../src/motion/step-history.ts';
import {rebuildStoppedMotion,type StoppedEmitter} from '../src/homing/rebuild-motion.ts';
import type {MotionBinding} from '../src/motion/coordinator.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
for(const count of [4,16]){
 const emitters:StoppedEmitter[]=Array.from({length:count},(_,i)=>({id:`s${i}`,queueId:'xyz',member:0,settings:{...settings,oid:i},mode:'x',rotationDistance:1,stepsPerRotation:100}));
 const result={hitClock:1000000n,reasons:[1],positions:emitters.map((e,i)=>({member:0,oid:e.settings.oid,raw:2500+i,position:BigInt(2500+i),observedClock:1500000n}))};
 function seed():MotionBinding[]{const q=new TrapQueue();return emitters.map(e=>({id:e.id,queue:q,stepper:q.createStepper(e.settings,e.mode,.01)}));}
 function raw(old:readonly MotionBinding[]){
  const q=new TrapQueue();q.setPosition(1.6,25,0,0);
  const bindings=emitters.map((e,i)=>{const stepper=q.createStepper(e.settings,e.mode,.01,[25,0,0]),p=result.positions[i],position=new StepperPosition(1,100);position.align(p.position,stepper.commandedPosition);stepper.initializePosition(p.observedClock,p.position);return {id:e.id,queue:q,stepper,position,history:new StepHistory(p.observedClock,p.position)};});
  for(const b of old)b.stepper.dispose();old[0].queue.dispose();return bindings;
 }
 const rawTimes:number[]=[],guardedTimes:number[]=[],batch=100;
 for(let round=0;round<14;round++)for(const guarded of round%2?[true,false]:[false,true]){
  let state=seed();const start=performance.now();
  for(let i=0;i<batch;i++)state=guarded?[...rebuildStoppedMotion(result,state,[{id:'xyz',position:[25,0,0]}],emitters,1.6).bindings]:raw(state);
  const elapsed=performance.now()-start;
  state.forEach((b,i)=>assert.equal(b.stepper.flush().position,BigInt(2500+i)));
  for(const b of state)b.stepper.dispose();state[0].queue.dispose();
  if(round>=3)(guarded?guardedTimes:rawTimes).push(elapsed);
 }
 rawTimes.sort((a,b)=>a-b);guardedTimes.sort((a,b)=>a-b);
 assert(guardedTimes[10]/batch<2,'Desktop rebuild budget exceeded (2 ms per group)');
 console.log(JSON.stringify({node:process.version,steppers:count,rebuilds:batch,rawMedianMs:rawTimes[5],rawP95Ms:rawTimes[10],validatedMedianMs:guardedTimes[5],validatedP95Ms:guardedTimes[10],scope:'Host native queue/solver reconstruction at stopped boundary, direct same operations versus validated replacement. Excludes serial fencing, MCU reset and physical printing.'}));
}
