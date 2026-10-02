import assert from 'node:assert/strict';
import {configuredMotionFixture,generateConfiguredEmitter} from '../test/helpers/configured-motion.ts';
import {inputShaper} from '../src/motion/shaper.ts';
import type {StoppedEmitter} from '../src/homing/rebuild-motion.ts';
const f=configuredMotionFixture(),configured=f.emitters(),manual:readonly StoppedEmitter[]=[
 {id:'x',queueId:'xyz',member:0,settings:{frequency:1000000.25,timeOffset:.01,oid:0,maxError:25,queueStepTag:2,directionTag:3,invertDirection:true},mode:'x',rotationDistance:40,stepsPerRotation:3200,shapers:{x:inputShaper('mzv',40,.1)}},
 {id:'e',queueId:'e',member:1,settings:{frequency:999999.75,timeOffset:.02,oid:0,maxError:25,queueStepTag:2,directionTag:3,invertDirection:false},mode:'extruder',rotationDistance:40,stepsPerRotation:3200,pressureAdvance:{advance:.05,smoothTime:.04}},
];
for(let i=0;i<2;i++)assert.deepEqual(generateConfiguredEmitter(configured[i]),generateConfiguredEmitter(manual[i]));
const compile:number[]=[],wall=[[] as number[],[] as number[]],cpu=[[] as number[],[] as number[]];
for(let run=0;run<14;run++){
 const start=performance.now();for(let i=0;i<1000;i++)f.emitters();if(run>=3)compile.push((performance.now()-start)/1000);
 for(const variant of run%2?[0,1]:[1,0]){
  const entries=variant?configured:manual,start=performance.now(),used=process.cpuUsage();
  for(let i=0;i<100;i++)for(const e of entries)assert.equal(generateConfiguredEmitter(e).position,720n);
  const elapsed=performance.now()-start,usage=process.cpuUsage(used);if(run>=3){wall[variant].push(elapsed);cpu[variant].push((usage.user+usage.system)/1000);}
 }
}
const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[5],p95Ms:v[10]};},timing=wall.map(stats),usage=cpu.map(stats),planning=stats(compile);
console.log(JSON.stringify({node:process.version,samples:11,pairsPerSample:100,stepsPerPair:1440,compilePerPair:planning,variants:['manual','configured'],wall:timing,cpu:usage,exactCompressedPacketsAndHistory:true,scope:'Native MZV and pressure advance, two calibrated MCU clocks and inverted X. No serial IO or physical motion.'}));
assert(planning.medianMs<2,'Motion descriptor compilation exceeded 2 ms startup budget');assert(timing[1].medianMs<timing[0].medianMs*1.2+5,'Configured native motion wall regression');assert(usage[1].medianMs<usage[0].medianMs*1.2+5,'Configured native motion CPU regression');
