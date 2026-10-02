import test from 'node:test';
import assert from 'node:assert/strict';
import {BLTouchDevice} from '../src/homing/bltouch-device.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
test('failed stop still waits for active motion before freeing native resources',async()=>{
 const t=await nativeLinearFixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const g=t.generation,originalDrain=g.source.drain.bind(g.source),originalStop=g.drain.stop.bind(g.drain),failure=new Error('injected independent stop failure');
 g.source.drain=async(...args)=>{entered.resolve();await release.promise;return originalDrain(...args);};
 g.drain.stop=async cause=>{await originalStop(cause);throw failure;};
 let disposing:Promise<void>|undefined;
 try{
  t.kinematics.markHomed([0]);t.port.move([50.1,0,0,2],10);
  const running=t.port.drain(new AbortController().signal),rejected=assert.rejects(running);await entered.promise;
  disposing=t.port.dispose();assert.strictEqual(t.port.dispose(),disposing);const stopped=assert.rejects(disposing,error=>{
   assert(error instanceof AggregateError);assert.deepEqual(error.errors,[failure]);return true;
  });
  await originalStop(new Error('test stop'));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(t.port.status.busy,true);assert.doesNotThrow(()=>g.motion.bindings[0].stepper.calibration);
  release.resolve();await Promise.all([rejected,stopped]);
  assert.equal(t.port.status.busy,false);assert.equal(t.kinematics.status.homedAxes,'');assert.throws(()=>g.motion.bindings[0].stepper.calibration,/closed/);assert.equal(t.f.stops,1);
  assert.strictEqual(t.port.dispose(),disposing);
 }finally{release.resolve();await disposing?.catch(()=>{});await t.f.close();}
});
test('disposal waits for independent probe stop and preserves motion, probe and cleanup failures',async()=>{
 const motionFailure=new Error('independent motion stop failure'),probeFailure=new Error('independent probe stop failure'),cleanupFailure=new Error('native resource cleanup failure');
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let probeStops=0,disposals=0;
 const t=await nativeLinearFixture(0,()=>false,false,undefined,false,false,false,{pin:'PA13',z_offset:'1.25'},undefined,undefined,false,async(_endstop,stop)=>{
  const device=new BLTouchDevice({
   clockAt:time=>BigInt(Math.trunc(time*1e6)),printAt:clock=>Number(clock)/1e6,secondsToClock:time=>BigInt(Math.trunc(time*1e6)),
   estimatedPrintTime:()=>serialClock.now(),motionPrintTime:()=>serialClock.now(),
   async waitUntil(){},async verifyState(){return true;},async setPWM(){},
   async stop(cause){probeStops++;entered.resolve();await release.promise;await stop(cause);throw probeFailure;},
  },{pinMoveTime:.3,stowOnEachSample:true,touchMode:false,pinUpNotTriggered:true,pinUpTouchTriggered:false,outputMode:null});
  await device.initialize(new AbortController().signal);return device;
 });
 const originalStop=t.generation.drain.stop.bind(t.generation.drain),queue=t.generation.motion.queues.at(-1)!.queue,originalDispose=queue.dispose.bind(queue);
 let disposing:Promise<void>|undefined;
 try{
  t.generation.drain.stop=async cause=>{await originalStop(cause);throw motionFailure;};
  queue.dispose=()=>{disposals++;originalDispose();throw cleanupFailure;};
  t.kinematics.markHomed([0,1,2]);disposing=t.port.dispose();let settled=false;
  const stopped=assert.rejects(disposing,error=>{
   assert(error instanceof AggregateError);assert.equal(error.errors.length,2);
   assert(error.errors[0] instanceof AggregateError);assert.deepEqual(error.errors[0].errors,[motionFailure,probeFailure]);
   assert.strictEqual(error.errors[1],cleanupFailure);return true;
  });
  void disposing.then(()=>{settled=true;},()=>{settled=true;});
  await entered.promise;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(settled,false);assert.equal(disposals,0);assert.equal(probeStops,1);
  assert.strictEqual(t.port.dispose(),disposing);assert.equal(t.kinematics.status.homedAxes,'');
  assert.doesNotThrow(()=>t.generation.motion.bindings[0].stepper.calibration);
  release.resolve();await stopped;
  assert.equal(settled,true);assert.equal(disposals,1);assert.equal(probeStops,1);assert.equal(t.f.stops,1);
  assert.throws(()=>t.generation.motion.bindings[0].stepper.calibration,/closed/);
  assert.strictEqual(t.port.dispose(),disposing);
 }finally{release.resolve();await disposing?.catch(()=>{});queue.dispose=originalDispose;await t.f.close();}
});
test('concurrent successful disposal shares completion and frees native resources once',async()=>{
 const t=await nativeLinearFixture();try{
  const first=t.port.dispose();assert.strictEqual(t.port.dispose(),first);await first;
  assert.throws(()=>t.generation.motion.bindings[0].stepper.calibration,/closed/);assert.equal(t.f.stops,1);
 }finally{await t.close();}
});
