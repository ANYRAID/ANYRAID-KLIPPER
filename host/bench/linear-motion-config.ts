import assert from 'node:assert/strict';
import {linearMotionReader} from '../test/helpers/linear-motion-config.ts';
import {readLinearMotionConfiguration} from '../src/config/linear-motion.ts';
const reader=linearMotionReader(),samples:number[]=[],cpu:number[]=[];
for(let run=0;run<14;run++){
 const begin=performance.now(),used=process.cpuUsage();
 for(let i=0;i<1000;i++){
  const c=readLinearMotionConfiguration(reader);assert.equal(c.kinematics.status.homedAxes,'');assert.equal(c.rails[0].endstop,51);assert.equal(c.limits.maxAccel,1000);assert.equal(c.extrusion.limits.maxVelocity,30);
 }
 const elapsed=(performance.now()-begin)/1000,usage=process.cpuUsage(used);if(run>=3){samples.push(elapsed);cpu.push((usage.user+usage.system)/1e6);}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},wall=stats(samples),usage=stats(cpu);
console.log(JSON.stringify({node:process.version,samples:11,configurationsPerSample:1000,wallPerConfiguration:wall,cpuPerConfiguration:usage,scope:'Configuration parsing and typed motion/homing/extrusion setup only; no pin allocation or hardware IO.'}));assert(wall.medianMs<1,'Motion configuration setup exceeded 1 ms median per configuration');
