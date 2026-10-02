import assert from 'node:assert/strict';
import {nativePrintFixture} from '../test/helpers/native-linear-print.ts';
import {createNativeLinearPrint} from '../src/operations/native-linear-print.ts';
const script=Array.from({length:1000},(_,i)=>`G1 X${50+(i+1)/1000} F600\n`).join('');
const values={hold:{stream:[] as number[],finish:[] as number[],cpu:[] as number[]},release:{stream:[] as number[],finish:[] as number[],cpu:[] as number[]}};
for(let run=0;run<14;run++)for(const policy of (run%2?['hold','release']:['release','hold']) as ('hold'|'release')[]){
 const f=await nativePrintFixture(script,false,true);f.options.motorCompletion=policy;const owner=await createNativeLinearPrint(f.options);
 try{
  const eof=Promise.withResolvers<void>();owner.device.subscribeEOF(()=>eof.resolve());owner.device.subscribeFault(e=>eof.reject(e));const signal=new AbortController().signal;
  const cpu=process.cpuUsage(),start=performance.now();await owner.device.prepare({version:1,requestId:'job',fileId:'file',nozzle:200,bed:60},signal);await owner.device.start('file',signal);await eof.promise;
  const stream=performance.now()-start,begin=performance.now();await owner.device.finish('job',signal);const finish=performance.now()-begin,used=process.cpuUsage(cpu);
  const writes=f.t.f.fw.outputs.filter(m=>m.name==='queue_digital_out');assert.deepEqual(writes.map(m=>m.parameters.on_ticks),policy==='release'?[0,1]:[0]);
  assert.equal(f.t.generation.motorEnable!.status.lines[0].enabled,policy==='hold');assert.deepEqual(f.resetCounts,[2,2]);assert.equal(f.outputFinishes,1);assert.equal(f.outputStops,0);assert.equal(f.t.port.status.failed,false);
  const x=f.t.generation.motion.bindings.find(b=>b.id==='x')!;assert.equal(x.history.status.lastPlannedPosition,200n);assert.equal(f.t.f.fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===3).reduce((sum,m)=>sum+Number(m.parameters.count),0),100);
  if(policy==='release')assert(f.t.generation.members[0].session.clock.sync.lastClock>BigInt(Number(writes[1].parameters.clock))+100000n);
  if(run>=3){values[policy].stream.push(stream);values[policy].finish.push(finish);values[policy].cpu.push((used.user+used.system)/1000);}
 }finally{await owner.close();await f.close();}
}
const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[5],p95Ms:v[10]};};
const summarize=(v:typeof values.hold)=>({stream:stats(v.stream),finish:stats(v.finish),cpu:stats(v.cpu)}),hold=summarize(values.hold),release=summarize(values.release);
console.log(JSON.stringify({node:process.version,samples:11,commands:1000,hold,release,scope:'Native file stream and completion, simulated heater and GPIO acknowledgements; release includes 200 ms motor guards. No physical printer acceptance.'}));
assert(release.stream.medianMs<=hold.stream.medianMs*1.1+10,'Motor completion policy regressed file streaming');assert(release.finish.medianMs>=190&&release.finish.medianMs<hold.finish.medianMs+500,'Release completion exceeded guard and sampling budget');assert(release.cpu.medianMs<=hold.cpu.medianMs*1.5+5,'Release completion CPU regression');
