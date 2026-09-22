import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync,rmSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {MCUGroup} from '../src/runtime/mcu-group.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialFirmware} from '../test/helpers/serial-firmware.ts';
const baseline='69a9fdb3',temporary=new URL(`../src/runtime/.group-baseline-${process.pid}.ts`,import.meta.url);
const elapsed:number[][]=[[],[]],cpu:number[][]=[[],[]];
try{
 writeFileSync(temporary,execFileSync('git',['show',`${baseline}:host/src/runtime/mcu-group.ts`]),{flag:'wx'});
 const Before=(await import(temporary.href) as {MCUGroup:typeof MCUGroup}).MCUGroup;
 for(let round=0;round<14;round++)for(const index of round%2?[1,0]:[0,1]){
  const fw=await serialFirmware(),signal=new AbortController().signal,C=index?MCUGroup:Before;let stops=0;
  const g=new C([{id:'m',async connect(signal,stopDevice){const s=new SerialSession(fw.fd,{stopDevice});await s.initialize(signal);return s;},async stopDevice(){stops++;}}]);
  try{
   await g.start(signal);const s=g.session('m');await s.configure({oidCount:4,commands:[]},signal);
   const transport=g.motionQueue('m',['x'],()=>0n).transport;
   const packets=Array.from({length:16},(_,i)=>({id:'x',data:Buffer.from(s.dictionary.encode('set_next_step_dir',{oid:3,dir:i%2})),minClock:0n,reqClock:0n}));
   const used=process.cpuUsage(),start=performance.now();
   for(let batch=0;batch<100;batch++)await transport.send(packets);
   await s.waitForAcknowledgements(signal);
   const ms=performance.now()-start,usage=process.cpuUsage(used);
   assert.equal(fw.motion.length,1600);assert(fw.motion.every((m,i)=>m.name==='set_next_step_dir'&&m.parameters.dir===i%2));assert.equal(stops,0);g.assertActive();
   if(round>=3){elapsed[index].push(ms);cpu[index].push((usage.user+usage.system)/1000);}
  }finally{await g.stop();await fw.close();}
 }
 for(const s of [...elapsed,...cpu])s.sort((a,b)=>a-b);
 const stats=(s:number[])=>({medianMs:s[5],p95Ms:s[10]});
 console.log(JSON.stringify({node:process.version,baseline,samples:11,batches:100,packets:1600,previous:{elapsed:stats(elapsed[0]),cpu:stats(cpu[0])},current:{elapsed:stats(elapsed[1]),cpu:stats(cpu[1])},scope:'group wrapper, native serial queue and emulator ACK; startup excluded; no real printer'}));
 assert(elapsed[1][5]<=elapsed[0][5]*1.25+1,'Median serial send regressed more than 25% plus 1ms');
 assert(cpu[1][5]<=cpu[0][5]*1.25+1,'Median send CPU regressed more than 25% plus 1ms');
}finally{rmSync(temporary,{force:true});}
