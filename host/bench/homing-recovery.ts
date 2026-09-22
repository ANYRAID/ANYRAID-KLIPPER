import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {recoveryFixture} from '../test/helpers/homing-recovery.ts';
import {HomingRecovery} from '../src/homing/recovery.ts';
import {HomingStopConfirmation} from '../src/homing/stop-confirmation.ts';
import {rebuildStoppedMotion} from '../src/homing/rebuild-motion.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
import {MoveQueueSink} from '../src/motion/move-queue-sink.ts';
const f=await recoveryFixture(),signal=new AbortController().signal,times:number[][]=[[],[]];let motion:ReturnType<typeof rebuildStoppedMotion>|undefined;
try{
 for(let round=0;round<14;round++)for(const checked of round%2?[1,0]:[0,1]){
  const start=performance.now();for(let operation=0;operation<20;operation++){
   if(motion){f.options.bindings=motion.bindings;const sink=new MoveQueueSink(f.sessions.map((s,i)=>s.motionQueue(`m${i}`,[`s${i}`],t=>motion!.bindings[i].stepper.clockAt(t))),async()=>{},motion.printTime);f.options.coordinator=new MotionCoordinator(motion.bindings,sink,16*1024*1024,motion.printTime);}
   if(checked)motion=(await new HomingRecovery(f.options).recover(signal)).motion;
   else{
    const o=f.options,[,result]=await Promise.all([o.coordinator.retire(signal),new HomingStopConfirmation(o.members,o.primary,o.endstop,o.sampling,o.release).finish(signal)]),located=o.locate(result);
    motion=rebuildStoppedMotion(result,o.bindings,located.queues,o.emitters,located.printTime);
    await Promise.all(o.members.map(async m=>{for(const step of m.steppers)await m.queue.send(m.session.dictionary.encode('reset_step_clock',{oid:step.oid,clock:0}),0n,0n,signal);}));
   }
   assert.deepEqual(motion.bindings.map(b=>b.stepper.flush().position),[100n,101n]);
  }
  if(round>=3)times[checked].push(performance.now()-start);
 }
 times.forEach(v=>v.sort((a,b)=>a-b));console.log(JSON.stringify({node:process.version,operations:20,mcus:2,rawMedianMs:times[0][5],rawP95Ms:times[0][10],recoveryMedianMs:times[1][5],recoveryP95Ms:times[1][10],scope:'same simulated stop/retire/rebuild/reset sequence, not physical homing or native trigger dispatch'}));assert(times[1][5]<=times[0][5]*1.5,'Recovery median overhead exceeded 50%');
}finally{motion?.dispose();await f.close();}
