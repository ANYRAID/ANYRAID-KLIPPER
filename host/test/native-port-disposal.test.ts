import test from 'node:test';
import assert from 'node:assert/strict';
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
  disposing=t.port.dispose();assert.strictEqual(t.port.dispose(),disposing);const stopped=assert.rejects(disposing,error=>error===failure);
  await originalStop(new Error('test stop'));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(t.port.status.busy,true);assert.doesNotThrow(()=>g.motion.bindings[0].stepper.calibration);
  release.resolve();await Promise.all([rejected,stopped]);
  assert.equal(t.port.status.busy,false);assert.equal(t.kinematics.status.homedAxes,'');assert.throws(()=>g.motion.bindings[0].stepper.calibration,/closed/);assert.equal(t.f.stops,1);
  assert.strictEqual(t.port.dispose(),disposing);
 }finally{release.resolve();await disposing?.catch(()=>{});await t.f.close();}
});
test('concurrent successful disposal shares completion and frees native resources once',async()=>{
 const t=await nativeLinearFixture();try{
  const first=t.port.dispose();assert.strictEqual(t.port.dispose(),first);await first;
  assert.throws(()=>t.generation.motion.bindings[0].stepper.calibration,/closed/);assert.equal(t.f.stops,1);
 }finally{await t.close();}
});
