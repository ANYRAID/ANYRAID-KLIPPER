import assert from 'node:assert/strict';
import {nativeLinearFixture} from '../test/helpers/native-linear-port.ts';
const signal=()=>new AbortController().signal,times:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let run=0;run<14;run++)for(const fan of run%2?[1,0]:[0,1]){
 const t=await nativeLinearFixture(0,()=>false,false,fan?{kickStartTime:0,minimumScheduleTime:.001}:undefined);
 try{
  if(fan){await t.port.queueCoolingFan(.5,signal());await t.port.drain(signal());}
  const begin=performance.now(),used=process.cpuUsage();for(let i=0;i<5;i++)await t.port.forcePosition([50+i/10,0,0,2],signal());const elapsed=performance.now()-begin,usage=process.cpuUsage(used);
  assert.deepEqual(t.port.position(),[50.4,0,0,2]);assert.equal(t.f.stops,0);assert.equal(t.f.fw.motion.filter(m=>m.name==='queue_step').length,0);
  if(fan){assert.equal(t.f.fw.outputs.filter(m=>m.name==='reset_pwm_out_generation').length,1);assert.deepEqual(t.f.fw.outputs.filter(m=>m.name==='queue_pwm_out_generation').map(m=>m.parameters.value),[128]);await t.port.queueCoolingFan(0,signal());await t.port.drain(signal());assert.equal(t.timeline!.status.pending,0);assert.deepEqual(t.f.fw.outputs.filter(m=>m.name==='queue_pwm_out_generation').map(m=>m.parameters.value),[128,0]);}
  if(run>=3){times[fan].push(elapsed);cpu[fan].push((usage.user+usage.system)/1000);}
 }finally{await t.close();}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=times.map(stats),usage=cpu.map(stats);
console.log(JSON.stringify({node:process.version,samples:11,rebasesPerSample:5,variants:['motionOnly','motionAndFanTransfer'],timing,cpu:usage,scope:'Native recovery/reset ACKs, unchanged PWM generation and confirmed fan control after five rebases; serial firmware emulator, no physical hardware.'}));assert(timing[1].medianMs<=timing[0].medianMs*1.3+5);assert(usage[1].medianMs<=usage[0].medianMs*1.5+3);
