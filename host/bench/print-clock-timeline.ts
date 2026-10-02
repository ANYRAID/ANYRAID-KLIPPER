import assert from 'node:assert/strict';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
import {snapshotPrintClock} from '../src/timing/print-clock.ts';
const history=new PrintClockTimeline({offset:0,frequency:1e6});
for(let i=1;i<512;i++)history.append(BigInt(i)*1000000n,1e6+(i%2?100:-100));
const snapshot=snapshotPrintClock(history.status.calibration),iterations=100000,wall:number[][]=[[],[]],cpu:number[][]=[[],[]];let checksum=0;
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const clock=mode?history:snapshot,start=performance.now(),used=process.cpuUsage();
 for(let i=0;i<iterations;i++){const tick=512000000n+BigInt(i);checksum+=Number(clock.clockAt(clock.printTimeAtClock(tick))-tick);}
 const elapsed=(performance.now()-start)/iterations,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000/iterations);}
}
assert.equal(checksum,0);const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats),limits={wallP95Ms:.005,cpuMedianMs:.005};
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,iterations,segments:512,variants:['snapshot','timeline'],timing,cpu:usage,limits,scope:'Two clock conversions per operation over 512 retained segments; no IO or motion execution.'}));
assert(timing[1].p95Ms<limits.wallP95Ms);assert(usage[1].medianMs<limits.cpuMedianMs);
