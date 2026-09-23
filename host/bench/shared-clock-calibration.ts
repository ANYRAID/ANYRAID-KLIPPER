import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]],iterations=256;
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 using q=new TrapQueue();q.appendRaw(new Float64Array([0,0,iterations+1,0,0,0,0,0,0,0,0,0,0]));
 using stepper=q.createStepper({frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6},'x',.01);
 const coordinator=new MotionCoordinator([{id:'x',queue:q,stepper}],{async commit(){},async stop(){}}),clock=new PrintClockTimeline({offset:0,frequency:1e6}),used=process.cpuUsage(),start=performance.now();
 for(let i=1;i<=iterations;i++){
  await coordinator.advanceWindow(i,i-.01);
  if(mode)clock.calibrateMotion(BigInt(i)*1000000n,1e6,coordinator,['x']);else{coordinator.calibrateClock(['x'],0,1e6);clock.append(BigInt(i)*1000000n,1e6);}
 }
 const elapsed=(performance.now()-start)/iterations,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000/iterations);}
 assert.equal(stepper.clockAt(iterations),clock.clockAt(iterations));assert.equal(clock.status.segments,iterations+1);
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats),limits={medianRatio:1.5,slackMs:.01,p95Ms:.1};
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,iterations,variants:['separateCalibration','sharedTransaction'],timing,cpu:usage,limits,scope:'Stationary native generation and zero-drift calibration transactions; no IO or physical printing. Frequency changes covered by precision tests.'}));
assert(timing[1].medianMs<timing[0].medianMs*limits.medianRatio+limits.slackMs);assert(usage[1].medianMs<usage[0].medianMs*limits.medianRatio+limits.slackMs);assert(timing[1].p95Ms<limits.p95Ms);
