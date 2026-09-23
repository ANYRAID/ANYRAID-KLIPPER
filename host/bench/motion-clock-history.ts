import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]],iterations=10000;
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 using q=new TrapQueue();const steppers=Array.from({length:8},(_,oid)=>q.createStepper({frequency:1e6,timeOffset:0,oid,maxError:0,queueStepTag:5,directionTag:6},'x',.01));
 try{
  const timelines=[new PrintClockTimeline({offset:0,frequency:1e6}),new PrintClockTimeline({offset:0,frequency:1e6})],bindings=steppers.map((stepper,i)=>({id:`s${i}`,stepper,queue:q})),map=new Map(bindings.map((b,i)=>[b.id,timelines[i%2]])),clocks=Object.fromEntries(bindings.map(b=>[b.id,90000000n]));
  const c=new MotionCoordinator(bindings,{async commit(){},async stop(){}},1024,0,[],mode?map:undefined);for(const clock of timelines)for(let i=1;i<=128;i++)clock.append(BigInt(i)*1000000n,1e6);
  const start=performance.now(),used=process.cpuUsage();let cutoff=0;for(let i=0;i<iterations;i++)cutoff=c.historyCutoff(clocks);
  const elapsed=(performance.now()-start)/iterations,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000/iterations);}
  assert.equal(cutoff,59.999);await c.shutdown();
 }finally{for(const s of steppers)s.dispose();}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats),limits={medianRatio:2,slackMs:.002,p95Ms:.01};
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,iterations,emitters:8,segments:129,variants:['currentNativeMapping','historicalMapping'],timing,cpu:usage,limits,scope:'Eight-emitter history cutoff with two clock domains, lease checks included; no IO, native generation or physical printing.'}));
assert(timing[1].medianMs<timing[0].medianMs*limits.medianRatio+limits.slackMs);assert(usage[1].medianMs<usage[0].medianMs*limits.medianRatio+limits.slackMs);assert(timing[1].p95Ms<limits.p95Ms);
