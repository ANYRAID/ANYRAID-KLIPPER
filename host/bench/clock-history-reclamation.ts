import assert from 'node:assert/strict';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]],iterations=5000;
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const clock=new PrintClockTimeline({offset:0,frequency:1e6},mode?64:65536),reader=clock.retain(),used=process.cpuUsage(),start=performance.now();
 for(let i=1;i<=iterations;i++){
  const tick=BigInt(i)*4000000n,old=BigInt(Math.max(0,i*4-40))*1000000n;clock.append(tick,1e6);reader.advance(old);
  const cutoff=clock.historyCutoff(tick,30);if(mode&&cutoff!==undefined)clock.retireBefore(cutoff);
  assert.equal(clock.printTimeAtClock(old),Math.max(0,i*4-40));
 }
 const elapsed=(performance.now()-start)/iterations,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000/iterations);}
 assert.equal(clock.status.segments,mode?11:5001);reader.release();
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats),limits={medianRatio:3,slackMs:.002,p95Ms:.01};
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,iterations,simulatedSeconds:iterations*4,variants:['retainAllSegments','sampledRetirement'],retainedSegments:[5001,11],timing,cpu:usage,limits,scope:'Synthetic clock updates, delayed-reader lease and retention; no IO or physical printing.'}));
assert(timing[1].medianMs<timing[0].medianMs*limits.medianRatio+limits.slackMs);assert(usage[1].medianMs<usage[0].medianMs*limits.medianRatio+limits.slackMs);assert(timing[1].p95Ms<limits.p95Ms);
