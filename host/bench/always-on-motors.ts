import assert from 'node:assert/strict';
import {nativePrintFixture} from '../test/helpers/native-linear-print.ts';
import {createNativeLinearPrint} from '../src/operations/native-linear-print.ts';
const script=Array.from({length:1000},(_,i)=>`G1 X${50+(i+1)/1000} E${2+(i+1)/100000} F600\n`).join('');
const modes=['controlled','always','mixed'] as const,typeSamples=()=>({wall:[] as number[],cpu:[] as number[]}),samples={controlled:typeSamples(),always:typeSamples(),mixed:typeSamples()};
for(let run=0;run<14;run++)for(const mode of run%2?[...modes].reverse():modes){
 const f=await nativePrintFixture(script,false,mode==='controlled'?true:mode),owner=await createNativeLinearPrint(f.options);
 try{
  const eof=Promise.withResolvers<void>();owner.device.subscribeEOF(()=>eof.resolve());owner.device.subscribeFault(e=>eof.reject(e));const signal=new AbortController().signal,start=performance.now(),used=process.cpuUsage();
  await owner.device.prepare({version:1,requestId:'job',fileId:'file',nozzle:200,bed:60},signal);await owner.device.start('file',signal);await eof.promise;await owner.device.finish('job',signal);
  const elapsed=performance.now()-start,cpu=process.cpuUsage(used);assert.equal(f.t.generation.motion.bindings[0].history.status.lastPlannedPosition,200n);assert.equal(f.t.f.fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===3).reduce((sum,m)=>sum+Number(m.parameters.count),0),100);
  assert.deepEqual(f.t.f.fw.outputs.filter(m=>m.name==='queue_digital_out').map(m=>m.parameters.on_ticks),mode==='always'?[]:[0]);assert.deepEqual(f.resetCounts,[2,2]);assert.equal(f.t.f.stops,0);
  if(run>=3){samples[mode].wall.push(elapsed);samples[mode].cpu.push((cpu.user+cpu.system)/1000);}
 }finally{await owner.close();await f.close();}
}
const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[5],p95Ms:v[10]};},summary=Object.fromEntries(modes.map(mode=>[mode,{wall:stats(samples[mode].wall),cpu:stats(samples[mode].cpu)}]));
console.log(JSON.stringify({node:process.version,samples:11,commands:1000,summary,scope:'Native XYZ/E print and hold completion; simulated MCU and heater. No physical power-state or printer acceptance.'}));
for(const mode of ['always','mixed']){assert(summary[mode].wall.medianMs<=summary.controlled.wall.medianMs*1.1+10,'Always-on print wall regression');assert(summary[mode].cpu.medianMs<=summary.controlled.cpu.medianMs*1.5+5,'Always-on print CPU regression');}
