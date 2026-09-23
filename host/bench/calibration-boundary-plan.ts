import assert from 'node:assert/strict';
import {ClockSync} from '../src/timing/clock-sync.ts';
import {SecondarySync} from '../src/timing/secondary-sync.ts';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]],iterations=256;
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const sync=new SecondarySync(new ClockSync(1e6,0n,0),new ClockSync(2e6,0n,0),0),clock=new PrintClockTimeline(sync.mapping);
 using q=new TrapQueue();q.appendRaw(new Float64Array([0,0,iterations+1,0,0,0,0,0,0,0,0,0,0]));
 using stepper=q.createStepper({frequency:2e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6},'x',.01);
 const coordinator=new MotionCoordinator([{id:'x',queue:q,stepper}],{async commit(){},async stop(){}}),used=process.cpuUsage(),start=performance.now();
 for(let i=1;i<=iterations;i++){
  const generated=mode?i-.000000123:i;await coordinator.advanceWindow(generated,i-.01);const p=sync.propose(i,i);
  if(mode){const plan=sync.planShared(p,clock,coordinator,i+.001)!;assert(plan);await coordinator.advanceWindow(plan.time,i-.01);}
  sync.applyShared(p,clock,coordinator,['x']);
 }
 const elapsed=(performance.now()-start)/iterations,usage=process.cpuUsage(used);
 if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000/iterations);}
 assert.deepEqual(stepper.calibration,clock.status.calibration);assert.deepEqual(sync.mapping,{...stepper.calibration,syncTime:iterations+4});assert.equal(clock.status.segments,iterations+1);await coordinator.shutdown();
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats),limits={medianRatio:1.5,slackMs:.01,p95Ms:.1};
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,iterations,variants:['alreadyAligned','plannedFractionalBoundary'],timing,cpu:usage,limits,scope:'Stationary native generation, secondary proposals, exact-boundary planning and extra native generation; no IO or physical printing.'}));
assert(timing[1].medianMs<timing[0].medianMs*limits.medianRatio+limits.slackMs);assert(usage[1].medianMs<usage[0].medianMs*limits.medianRatio+limits.slackMs);assert(timing[1].p95Ms<limits.p95Ms);
