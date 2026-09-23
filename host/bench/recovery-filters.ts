import assert from 'node:assert/strict';
import {nativeFilterTrace} from '../test/helpers/native-filter-trace.ts';
const times:number[][]=[[],[]],cpu:number[][]=[[],[]],total:number[][]=[[],[]],totalCpu:number[][]=[[],[]];let reference:Awaited<ReturnType<typeof nativeFilterTrace>>|undefined,error=0n;
for(let run=0;run<14;run++)for(const variant of run%2?[1,0]:[0,1]){
 const start=performance.now(),used=process.cpuUsage(),result=await nativeFilterTrace(variant?3:0),elapsed=performance.now()-start,usage=process.cpuUsage(used);reference??=result;assert.deepEqual(result.filters,reference.filters);
 for(const axis of ['x','e']){assert.equal(result.ticks[axis].length,reference.ticks[axis].length);for(let i=0;i<result.ticks[axis].length;i++){const [time,position]:[bigint,bigint]=result.ticks[axis][i],[expected,prior]:[bigint,bigint]=reference.ticks[axis][i];assert.equal(position,prior);const delta:bigint=time>expected?time-expected:expected-time;if(delta>error)error=delta;assert(delta<=1n);}}
 if(run>=3){times[variant].push(result.elapsedMs);cpu[variant].push(result.cpuMs);total[variant].push(elapsed);totalCpu[variant].push((usage.user+usage.system)/1000);}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=times.map(stats),usage=cpu.map(stats);
const lifecycleTiming=total.map(stats),lifecycleCpu=totalCpu.map(stats);
console.log(JSON.stringify({node:process.version,samples:11,variants:['freshFilteredMotion','threeRebuildsThenFilteredMotion'],timing,cpu:usage,lifecycleTiming,lifecycleCpu,pulses:Object.fromEntries(Object.entries(reference!.ticks).map(([id,t])=>[id,t.length])),maxRelativeTickError:String(error),scope:'Native MZV and pressure advance pulse histories, actual serial emulation and clock drain; timing excludes setup/rebuild, lifecycle includes setup/rebuild/close, no hardware acceptance.'}));assert(timing[1].medianMs<=timing[0].medianMs*1.1+10);assert(usage[1].medianMs<=usage[0].medianMs*1.5+3);assert(lifecycleTiming[1].medianMs<=lifecycleTiming[0].medianMs*1.1+10);assert(lifecycleCpu[1].medianMs<=lifecycleCpu[0].medianMs*1.5+3);
