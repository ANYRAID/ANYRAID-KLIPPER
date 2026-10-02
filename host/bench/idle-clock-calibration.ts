import assert from 'node:assert/strict';
import {nativeLinearFixture} from '../test/helpers/native-linear-port.ts';
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const t=await nativeLinearFixture(0,()=>false,true,undefined,false,true,true);try{
  const signal=new AbortController().signal,used=process.cpuUsage(),start=performance.now();
  if(mode)assert.deepEqual(await t.port.maintainIdleClocks(signal),{attempted:1,updated:1});else await t.port.pause(signal);
  const elapsed=performance.now()-start,usage=process.cpuUsage(used);
  if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000);}
  assert.equal(t.generation.clockTimelines!.find(c=>c.id==='m')!.timeline.status.segments,mode?2:1);
  assert.equal(t.f.fw.motion.filter(m=>m.name==='queue_step').length,0);assert.equal(t.f.stops,0);
  assert.deepEqual(t.generation.motion.bindings.map(b=>b.history.status.lastPlannedPosition),[100n,20n,0n,0n]);
 }finally{await t.close();}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats),limits={wallRatio:1.25,wallSlackMs:20,cpuRatio:2,cpuSlackMs:2};
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,variants:['stationaryPauseCheckpoint','stationaryCalibrationCheckpoint'],timing,cpu:usage,limits,scope:'Shaped native motion stationary checkpoint, two emulated MCUs, ACK and time drain; no physical printing.'}));
assert(timing[1].medianMs<timing[0].medianMs*limits.wallRatio+limits.wallSlackMs);assert(usage[1].medianMs<usage[0].medianMs*limits.cpuRatio+limits.cpuSlackMs);
