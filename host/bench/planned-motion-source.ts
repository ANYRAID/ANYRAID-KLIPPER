import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
import {MoveQueueSink} from '../src/motion/move-queue-sink.ts';
import {CoordinatedMotionDrain} from '../src/motion/coordinated-drain.ts';
import {PlannedMotionSource} from '../src/motion/planned-motion-source.ts';
import {MCUGroup} from '../src/runtime/mcu-group.ts';
import {Move,motionLimits} from '../src/motion/lookahead.ts';
const limits=motionLimits(300,3000),moves=Array.from({length:10000},(_,i)=>{const m=new Move(limits,[i,0,0,i/10],[i+1,0,0,(i+1)/10],10);m.setJunction(0,100,0);return m;});
const timings:{source:number[];direct:number[]}={source:[],direct:[]};let reference:Float64Array[]|undefined;
for(let i=0;i<16;i++)for(const mode of i%2?['source','direct'] as const:['direct','source'] as const){
 using xyz=new TrapQueue();using extrusion=new TrapQueue();const settings={frequency:1e6,timeOffset:0,maxError:0,queueStepTag:8,directionTag:9};using x=xyz.createStepper({...settings,oid:3},'x',.01);using e=extrusion.createStepper({...settings,oid:4},'extruder',.01);
 const group=new MCUGroup([{id:'m',async connect(){throw new Error('Append benchmark must not connect');},async stopDevice(){}}]);
 const sink=new MoveQueueSink([{id:'m',moveSlots:512,emitters:['x','e'],clockAt:t=>x.clockAt(t),transport:{async send(){},async stop(){}}}],async()=>{});
 const coordinator=new MotionCoordinator([{id:'x',queue:xyz,stepper:x},{id:'e',queue:extrusion,stepper:e}],sink),source=new PlannedMotionSource([{queue:xyz},{queue:extrusion,extrusionAxis:3}],new CoordinatedMotionDrain(coordinator,sink,group),1,[0,0,0,0]);
 const begin=performance.now();if(mode==='source')source.append(moves);else{xyz.appendPlanned(moves,1);extrusion.appendPlanned(moves,1,3);}const elapsed=performance.now()-begin;if(i>=5)timings[mode].push(elapsed);
 const actual=[xyz.extract(65536,0,1e10),extrusion.extract(65536,0,1e10)];if(!reference)reference=actual;else assert.deepEqual(actual,reference);
}
for(const values of Object.values(timings))values.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,moves:10000,sourceMedianMs:timings.source[5],sourceP95Ms:timings.source[10],directMedianMs:timings.direct[5],directP95Ms:timings.direct[10],scope:'Append validated planned XYZ/extrusion batches only; native extracted trajectories exactly match direct append. No generation, serial, physical movement or equal-work Python comparison.'},null,2));
