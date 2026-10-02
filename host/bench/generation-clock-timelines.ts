import assert from 'node:assert/strict';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {rebuiltFixture} from '../test/helpers/rebuilt-motion.ts';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
import {BedMeshMovePort} from '../src/motion/bed-mesh-port.ts';
import {motionLimits} from '../src/motion/lookahead.ts';
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]],binding:number[][]=[[],[]];
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const f=await rebuiltFixture(false,false,false,false,true);try{
  const clocks=['m','a'].map(id=>({id,timeline:new PrintClockTimeline({offset:0,frequency:1e6})})),used=process.cpuUsage(),start=performance.now();
  const g=await bindRebuiltMotion({...f.options,clockTimelines:mode?clocks:undefined}),bound=performance.now()-start,port=new BedMeshMovePort({mesh:null,physicalPosition:f.options.position,limits:motionLimits(100,1000),validate(){}});
  port.move([51,0,0,2.1],10);await g.source.drain(port.flush(),new AbortController().signal);
  const elapsed=performance.now()-start,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000);binding[mode].push(bound);}
  assert.equal(g.motion.bindings[0].history.status.lastPlannedPosition,200n);assert.equal(g.motion.bindings[1].history.status.lastPlannedPosition,30n);assert.equal(f.auxFw!.motion.length,0);assert.equal(f.stops,0);
  if(mode)assert(clocks[1].timeline.status.reservedThrough>0n);
 }finally{await f.close();}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats),bindings=binding.map(stats),limits={medianRatio:1.25,cpuRatio:1.5,cpuSlackMs:1,bindingMedianMs:1};
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,variants:['fixedGeneration','sharedGeneration'],timing,cpu:usage,binding:bindings,limits,scope:'Rebuilt binding, native XYZ/extrusion, history, ACK and two-MCU drain; setup excluded, emulated firmware, no hardware acceptance.'}));
assert(timing[1].medianMs<timing[0].medianMs*limits.medianRatio);assert(usage[1].medianMs<usage[0].medianMs*limits.cpuRatio+limits.cpuSlackMs);assert(bindings[1].medianMs<limits.bindingMedianMs);
