import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {nativePrintFixture} from '../test/helpers/native-linear-print.ts';
import {createNativeLinearPrint} from '../src/operations/native-linear-print.ts';
import {bindNativeFileMotion} from '../src/operations/native-file-motion.ts';
import {FilePrintDevice} from '../src/operations/file-print-device.ts';
import {ThermalPrintDevice} from '../src/operations/thermal-print-device.ts';
const script=Array.from({length:1000},(_,i)=>`G1 X${50+(i+1)/1000} F600\n`).join('');
const values={manual:{wall:[] as number[],cpu:[] as number[]},assembled:{wall:[] as number[],cpu:[] as number[]}};
for(let i=0;i<34;i++)for(const mode of (i%2?['assembled','manual']:['manual','assembled']) as ('manual'|'assembled')[]){
 const f=await nativePrintFixture(script);let device:ThermalPrintDevice|undefined,close:(()=>Promise<void>)|undefined;
 try{
  if(mode==='assembled'){const owner=await createNativeLinearPrint(f.options);device=owner.device;close=owner.close;}
  else{
   const o=f.options,motion=bindNativeFileMotion(o.port,o.parking,{...o.lifecycle,prepare:async(r,s)=>{await o.lifecycle.prepare(r,s);s.throwIfAborted();o.gcode.enable();}});
   device=new ThermalPrintDevice(new FilePrintDevice(motion,o.gcode.dispatch,o.open),o.heaters,o.mapping);o.heaters.attach(o.gcode.dispatch,{bed:o.mapping.bed,extruders:[o.mapping.nozzle]});
  }
  const eof=Promise.withResolvers<void>();device.subscribeEOF(()=>eof.resolve());device.subscribeFault(e=>eof.reject(e));
  const used=process.cpuUsage(),start=performance.now(),signal=new AbortController().signal;
  await device.prepare({version:1,requestId:'job',fileId:'file',nozzle:200,bed:60},signal);await device.start('file',signal);await eof.promise;await device.finish('job',signal);
  const wall=performance.now()-start,cpu=process.cpuUsage(used);
  assert.equal(f.outputFinishes,1);assert.deepEqual(f.resetCounts,[2,2]);assert.equal(f.heaters.getTemperature('extruder').target,0);assert.equal(f.heaters.getTemperature('bed').target,0);
  assert.equal(f.t.generation.motion.bindings.find(b=>b.id==='x')!.history.status.lastPlannedPosition,200n);assert.equal(f.t.f.fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===3).reduce((sum,m)=>sum+Number(m.parameters.count),0),100);
  if(i>=3){values[mode].wall.push(wall);values[mode].cpu.push((cpu.user+cpu.system)/1000);}
 }finally{if(close)await close();else await device?.stop();await f.close();}
}
const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[15],p95Ms:v[29]};};
const manual={wall:stats(values.manual.wall),cpu:stats(values.manual.cpu)},assembled={wall:stats(values.assembled.wall),cpu:stats(values.assembled.cpu)};
console.log(JSON.stringify({node:process.version,commands:1000,samples:31,manual,assembled,raw:values,scope:'Native firmware emulator, file streaming, heater readiness with injected hot samples, native drain and simulated output ACKs. Excludes physical heating and printer throughput.'}));
assert(assembled.wall.medianMs<=manual.wall.medianMs*1.3+10,'Native print assembly wall regression');assert(assembled.cpu.medianMs<=manual.cpu.medianMs*1.3+2,'Native print assembly CPU regression');
