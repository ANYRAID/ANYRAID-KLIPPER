import assert from 'node:assert/strict';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]],iterations=100000;
const clock=new PrintClockTimeline({offset:0,frequency:1e6});
for(let i=1;i<=128;i++)clock.append(BigInt(i)*1000000n,1e6);
// Binary floating-point subtraction can retain one extra tick. Verify the
// conservative bound outside timing rather than requiring nearest rounding.
for(let i=0;i<iterations;i++){
 const observed=90000000n+BigInt(i),target=clock.printTimeAtClock(observed)-30,cutoff=clock.historyCutoff(observed,30)!;
 assert(clock.printTimeAtClock(cutoff)<=target);assert(clock.printTimeAtClock(cutoff+1n)>target);
}
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const start=performance.now(),used=process.cpuUsage();let sum=0n;
 for(let i=0;i<iterations;i++){const observed=90000000n+BigInt(i);sum+=mode?clock.historyCutoff(observed,30)!:observed-BigInt(Math.ceil(1e6*30));}
 const elapsed=(performance.now()-start)/iterations,usage=process.cpuUsage(used);
 const nearest=BigInt(iterations)*60000000n+BigInt(iterations)*(BigInt(iterations)-1n)/2n;
 if(mode)assert(sum<=nearest&&sum>=nearest-BigInt(iterations));else assert.equal(sum,nearest);
 if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000/iterations);}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats),limits={slackMs:.002,p95Ms:.005};
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,iterations,segments:129,variants:['fixedFrequency','historicalMapping'],timing,cpu:usage,limits,scope:'Per-emitter retention watermark only; no IO or physical printing.'}));
assert(timing[1].medianMs<timing[0].medianMs+limits.slackMs);assert(usage[1].medianMs<usage[0].medianMs+limits.slackMs);assert(timing[1].p95Ms<limits.p95Ms);
