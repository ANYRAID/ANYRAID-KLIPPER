import assert from 'node:assert/strict';
import {rebuiltFixture} from '../test/helpers/rebuilt-motion.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {RebuiltMotionStreamer} from '../src/runtime/motion-streamer.ts';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
import {LookAheadQueue,Move,motionLimits} from '../src/motion/lookahead.ts';
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const f=await rebuiltFixture();try{
  const g=await bindRebuiltMotion({...f.options,clockTimelines:mode?[{id:'m',timeline:new PrintClockTimeline({offset:0,frequency:1e6})}]:undefined}),stream=new RebuiltMotionStreamer(g),q=new LookAheadQueue(),signal=new AbortController().signal;
  for(let i=0;i<8;i++)q.add(new Move(motionLimits(100,1000),[50+i,0,0,2],[51+i,0,0,2],20));
  const moves=q.flush(),used=process.cpuUsage(),start=performance.now();await stream.append(moves,signal);await g.source.drain([],signal);
  const elapsed=performance.now()-start,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000);}
  assert.equal(g.motion.bindings[0].history.status.lastPlannedPosition,900n);assert.equal(f.stops,0);await g.coordinator.shutdown();
 }finally{await f.close();}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats),limits={wallRatio:1.25,cpuRatio:1.5,cpuSlackMs:1};
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,variants:['fixedStream','sharedStream'],timing,cpu:usage,limits,scope:'Paced native motion, clock checks, history, ACK and firmware-time drain with emulated firmware; no physical printing.'}));
assert(timing[1].medianMs<timing[0].medianMs*limits.wallRatio);assert(usage[1].medianMs<usage[0].medianMs*limits.cpuRatio+limits.cpuSlackMs);
