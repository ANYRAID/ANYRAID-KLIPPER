import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {rebuiltFixture} from '../test/helpers/rebuilt-motion.ts';
import {MoveQueueSink} from '../src/motion/move-queue-sink.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
import {CoordinatedMotionDrain} from '../src/motion/coordinated-drain.ts';
import {PlannedMotionSource} from '../src/motion/planned-motion-source.ts';
import {BedMeshMovePort} from '../src/motion/bed-mesh-port.ts';
import {motionLimits} from '../src/motion/lookahead.ts';
const elapsed:number[][]=[[],[]],cpu:number[][]=[[],[]],binding:number[][]=[[],[]];
for(let round=0;round<14;round++)for(const managed of round%2?[1,0]:[0,1]){
 const f=await rebuiltFixture();try{
  const {group,motion,routes,position}=f.options,used=process.cpuUsage(),start=performance.now();let source:PlannedMotionSource;
  if(managed)source=(await bindRebuiltMotion(f.options)).source;
  else{
   const sink=new MoveQueueSink([group.motionQueue('m',motion.bindings.map(b=>b.id),t=>motion.bindings[0].stepper.clockAt(t))],async outputs=>{for(const output of outputs){const b=motion.bindings.find(b=>b.id===output.id)!;b.history.append(output,b.stepper.clockAt(b.stepper.generatedTime));}},motion.printTime);
   const c=new MotionCoordinator(motion.bindings,sink,16*1024*1024,motion.printTime,[group]);source=new PlannedMotionSource(routes,new CoordinatedMotionDrain(c,sink,group),motion.printTime,position);
  }
  const bound=performance.now()-start,port=new BedMeshMovePort({mesh:null,physicalPosition:position,limits:motionLimits(100,1000),validate:()=>{}});
  port.move([51,0,0,2.1],10);await source.drain(port.flush(),new AbortController().signal);
  const ms=performance.now()-start,usage=process.cpuUsage(used);assert.equal(motion.bindings[0].history.status.lastPlannedPosition,200n);assert.equal(motion.bindings[1].history.status.lastPlannedPosition,30n);assert.equal(f.stops,0);
  if(round>=3){elapsed[managed].push(ms);cpu[managed].push((usage.user+usage.system)/1000);binding[managed].push(bound);}
 }finally{await f.close();}
}
for(const s of [...elapsed,...cpu,...binding])s.sort((a,b)=>a-b);
const stats=(s:number[])=>({medianMs:s[5],p95Ms:s[10]});
console.log(JSON.stringify({node:process.version,samples:11,manual:{elapsed:stats(elapsed[0]),cpu:stats(cpu[0]),binding:stats(binding[0])},managed:{elapsed:stats(elapsed[1]),cpu:stats(cpu[1]),binding:stats(binding[1])},scope:'post-recovery binding, native XYZ/extrusion generation, integer history, ACK and MCU-time drain; setup excluded; emulated firmware'}));
assert(elapsed[1][5]<=elapsed[0][5]*1.25,'Rebuilt drain elapsed regressed over 25%');assert(cpu[1][5]<=cpu[0][5]*1.5+1,'Rebuilt CPU regressed over 50% plus 1ms');assert(binding[1][5]<1,'Rebuilt binding exceeds 1ms median desktop budget');
