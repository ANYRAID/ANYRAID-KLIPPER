import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {initialLinearFixture} from '../test/helpers/initial-linear.ts';
import {createConfiguredNativeLinearPort} from '../src/config/linear-motion.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const f=await initialLinearFixture(),runtime=f.hardware.analog[0].runtime;let timer:ReturnType<typeof setInterval>|undefined,port:ReturnType<typeof createConfiguredNativeLinearPort>['port']|undefined;
 try{
  const result=mode?f.initial.createLinearPort(f.reader,f.settings):createConfiguredNativeLinearPort(f.reader,{...f.settings,canExtrude:()=>runtime.canExtrude(),generation:f.initial.generation,emitters:f.initial.emitters});port=result.port;
  const plan=f.hardware.plan.heaters[0],session=f.group.session(plan.sensor.mcu),raw=Math.round(plan.configuration.converter.adc(220)*plan.sensor.adc.maximumSum);
  const emit=()=>{const next=session.clock.sync.getClock(serialClock.now())+292000n;f.firmware[1].emit('analog_in_state',{oid:plan.sensor.adc.oid,next_clock:Number(BigInt.asUintN(32,next)),values:Buffer.from([raw&255,raw>>8])});};
  timer=setInterval(emit,50);emit();const deadline=performance.now()+4000;while(!runtime.canExtrude()){assert(performance.now()<deadline);await delay(10);}
  const used=process.cpuUsage(),begin=performance.now();for(let i=1;i<=1000;i++)port.move([0,0,0,i/10000],2);
  const elapsed=performance.now()-begin,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000);}
  await port.drain(f.signal);assert.deepEqual(port.position(),[0,0,0,.1]);
  const oid=f.hardware.plan.steppers.find(s=>s.emitter==='e')!.compressor.oid;assert.equal(f.firmware[0].motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===oid).reduce((n,m)=>n+Number(m.parameters.count),0),8);
 }finally{if(timer)clearInterval(timer);if(!mode)await port?.dispose();await f.hardware.close();await f.close();}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats);
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,moves:1000,steps:8,variants:['explicitLiveHeater','ownedConfiguredHeater'],timing,cpu:usage,scope:'ADC-warmed live heater permission on every extruding admission, same native XYZE hardware. Timing excludes warmup/drain; actual drain verifies eight pulses. Emulated MCU, no physical printer proof.'}));
assert(timing[1].medianMs<timing[0].medianMs*1.5+1);assert(timing[1].p95Ms<timing[0].p95Ms*2+2);assert(usage[1].medianMs<usage[0].medianMs*1.5+1);
