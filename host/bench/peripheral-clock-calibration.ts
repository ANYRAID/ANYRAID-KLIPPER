import assert from 'node:assert/strict';
import {ClockSync} from '../src/timing/clock-sync.ts';
import {SecondarySync} from '../src/timing/secondary-sync.ts';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]],iterations=256;
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const sync=new SecondarySync(new ClockSync(1e6,0n,0),new ClockSync(2e6,0n,0),0),clock=new PrintClockTimeline(sync.mapping),used=process.cpuUsage(),start=performance.now();
 for(let i=1;i<=iterations;i++){
  const p=sync.propose(i,i);
  if(mode){const plan=sync.planPeripheral(p,clock,i-.000000123,i+.001)!;assert(plan);sync.applyPeripheral(p,clock,plan.tick);}
  else{sync.apply(p,{calibrateClock(){}},['unused']);clock.append(BigInt(i)*2000000n,p.frequency);}
 }
 const elapsed=(performance.now()-start)/iterations,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000/iterations);}
 assert.deepEqual(sync.mapping,{...clock.status.calibration,syncTime:iterations+4});assert.equal(clock.status.segments,iterations+1);assert.equal(clock.clockAt(iterations+1),BigInt(iterations+1)*2000000n);
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats),limits={medianRatio:1.5,slackMs:.01,p95Ms:.1};
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,iterations,variants:['separatePeripheral','plannedPeripheralTransaction'],timing,cpu:usage,limits,scope:'Zero-drift proposals, exact planning and auxiliary publication; no native motion, IO or physical printing.'}));
assert(timing[1].medianMs<timing[0].medianMs*limits.medianRatio+limits.slackMs);assert(usage[1].medianMs<usage[0].medianMs*limits.medianRatio+limits.slackMs);assert(timing[1].p95Ms<limits.p95Ms);
