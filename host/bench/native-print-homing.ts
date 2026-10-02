import assert from 'node:assert/strict';
import {nativePrintHomingFixture} from '../test/helpers/native-print-homing.ts';
const values={direct:{wall:[] as number[],cpu:[] as number[]},queued:{wall:[] as number[],cpu:[] as number[]}};
for(let run=0;run<14;run++)for(const mode of (run%2?['direct','queued']:['queued','direct']) as ('direct'|'queued')[]){
 const h=await nativePrintHomingFixture(),f=h.f;
 try{
  const signal=new AbortController().signal,begin=performance.now(),used=process.cpuUsage();
  if(mode==='direct')await f.gcode.homing.home([0],signal);else await f.gcode.prepareForPrint({mode:'home',axes:[0]},async()=>{},signal);
  const wall=performance.now()-begin,cpu=process.cpuUsage(used);assert.equal(h.hits,1);assert.equal(f.t.port.position()[0],51);assert.equal(f.t.kinematics.status.homedAxes,'x');assert.equal(f.t.port.status.failed,false);assert.equal(f.t.f.stops,0);assert.equal(f.heaters.getTemperature('extruder').target,0);
  assert.deepEqual(f.t.f.fw.outputs.filter(m=>m.name==='queue_digital_out').map(m=>m.parameters.on_ticks),[0]);
  if(run>=3){values[mode].wall.push(wall);values[mode].cpu.push((cpu.user+cpu.system)/1000);}
 }finally{await h.close();}
}
const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[5],p95Ms:v[10]};},summary=(v:typeof values.direct)=>({wall:stats(v.wall),cpu:stats(v.cpu)}),direct=summary(values.direct),queued=summary(values.queued);
console.log(JSON.stringify({node:process.version,samples:11,direct,queued,scope:'Native homing with firmware trigger simulation and position recovery; compares direct homing with serialized typed startup. No hardware or homing repeatability acceptance.'}));
assert(queued.wall.medianMs<=direct.wall.medianMs*1.1+10,'Queued startup homing wall regression');assert(queued.cpu.medianMs<=direct.cpu.medianMs*1.5+3,'Queued startup homing CPU regression');
