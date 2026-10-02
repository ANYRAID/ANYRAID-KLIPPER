import assert from 'node:assert/strict';
import {nativeLinearFixture} from './native-linear-port.ts';
import {StepCompressor,type MotionFilterSettings} from '../../src/motion/step-compressor.ts';
import {TrapQueue} from '../../src/motion/trap-queue.ts';
import {PlannedMotionSource} from '../../src/motion/planned-motion-source.ts';
import {snapshotPrintClock} from '../../src/timing/print-clock.ts';
/** Per-process fixture: records actual native compressed pulse histories. */
export async function nativeFilterTrace(rebases:number,filtered=true){
 const ids=new WeakMap<StepCompressor,string>(),create=TrapQueue.prototype.createStepper,flush=StepCompressor.prototype.flushThrough,startAt=PlannedMotionSource.prototype.startAt;
 const ticks:Record<string,[bigint,bigint][]>= {x:[],e:[]},filters:Record<string,MotionFilterSettings>={};let collect=false,startClock:bigint|undefined,mapping:ReturnType<typeof snapshotPrintClock>;
 PlannedMotionSource.prototype.startAt=function(time){startAt.call(this,time);if(collect)startClock=mapping.clockAt(time);};
 TrapQueue.prototype.createStepper=function(...args){const s=create.apply(this,args);ids.set(s,args[1]==='extruder'?'e':String(args[1]));return s;};
 StepCompressor.prototype.flushThrough=function(time){const out=flush.call(this,time),id=ids.get(this)!;if(collect&&id in ticks){filters[id]??=this.recoveryFilters();for(let i=0;i<out.history.length;i+=6){const [first,,position,count,interval,add]=out.history.slice(i,i+6),n=count<0n?-count:count;for(let j=0n;j<n;j++)ticks[id].push([first+j*interval+add*j*(j+1n)/2n,position+(count<0n?-1n:1n)*(j+1n)]);}}return out;};
 let t:Awaited<ReturnType<typeof nativeLinearFixture>>|undefined;
 try{
  t=await nativeLinearFixture(0,()=>true,filtered);mapping=snapshotPrintClock(t.generation.motion.bindings[0].stepper.calibration);for(let i=0;i<rebases;i++)await t.port.forcePosition([50,0,0,2],new AbortController().signal);
  t.kinematics.markHomed([0]);collect=true;const begin=performance.now(),used=process.cpuUsage();t.port.move([51.5,0,0,2.15],10);await t.port.drain(new AbortController().signal);const elapsedMs=performance.now()-begin,cpu=process.cpuUsage(used);
  assert.equal(t.f.stops,0);assert.deepEqual(t.port.position(),[51.5,0,0,2.15]);
  assert(startClock!==undefined);for(const rows of Object.values(ticks)){rows.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);for(const row of rows)row[0]-=startClock;}
  return {ticks,filters,elapsedMs,cpuMs:(cpu.user+cpu.system)/1000};
 }finally{collect=false;try{await t?.close();}finally{TrapQueue.prototype.createStepper=create;StepCompressor.prototype.flushThrough=flush;PlannedMotionSource.prototype.startAt=startAt;}}
}
