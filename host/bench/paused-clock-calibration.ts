import assert from 'node:assert/strict';
import {nativeLinearFixture} from '../test/helpers/native-linear-port.ts';
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const t=await nativeLinearFixture(0,()=>false,true,undefined,false,true,true);try{
  const signal=new AbortController().signal;if(mode)await t.port.pause(signal);
  const used=process.cpuUsage(),start=performance.now();
  if(mode){const calibration=t.port.maintainPausedClocks(signal);await t.port.resumeStream(signal);assert.deepEqual(await calibration,{attempted:1,updated:1});}
  else assert.deepEqual(await t.port.maintainIdleClocks(signal),{attempted:1,updated:1});
  const elapsed=performance.now()-start,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000);}
  assert.equal(t.generation.clockTimelines![0].timeline.status.segments,2);assert.equal(t.f.fw.motion.filter(m=>m.name==='queue_step').length,0);assert.deepEqual(t.port.position(),[50,0,0,2]);assert.equal(t.f.stops,0);
 }finally{await t.close();}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats),limits={wallRatio:1.25,wallSlackMs:20,cpuRatio:1.5,cpuSlackMs:2};
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,variants:['idleCalibration','pausedCalibrationAndResumeBarrier'],timing,cpu:usage,limits,scope:'Stationary shaped native clock calibration, two emulated MCUs, paused resume waits for retirement; no physical printing.'}));
assert(timing[1].medianMs<timing[0].medianMs*limits.wallRatio+limits.wallSlackMs);assert(usage[1].medianMs<usage[0].medianMs*limits.cpuRatio+limits.cpuSlackMs);
