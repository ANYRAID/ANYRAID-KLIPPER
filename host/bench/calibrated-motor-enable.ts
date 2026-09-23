import assert from 'node:assert/strict';
import {MotorEnable,compileMotorEnable} from '../src/outputs/motor-enable.ts';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
import {MCUGroup} from '../src/runtime/mcu-group.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {serialFirmware} from '../test/helpers/serial-firmware.ts';
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]],iterations=10000,signal=new AbortController().signal;
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const fw=await serialFirmware(),group=new MCUGroup([{id:'m',async connect(s:AbortSignal,stopDevice:(cause:unknown)=>Promise<void>){const session=new SerialSession(fw.fd,{stopDevice});await session.initialize(s);return session;},async stopDevice(){}}]);
 try{
  await group.start(signal);const chip={},timeline=new PrintClockTimeline({offset:0,frequency:1e6});for(let i=1;i<128;i++)timeline.append(BigInt(i)*1000n,1e6);
  const plan=compileMotorEnable(group,{mcu:'m',chip,pin:{chip,chipName:'m',pin:'PA3',invert:0,pullup:0},oid:0,emitters:['x'],leadTime:.001,calibration:{offset:0,frequency:1e6},timeline:mode?timeline:undefined});
  await plan.session.configure({oidCount:1,commands:[plan.config.config],restart:[plan.config.restart],reservedMoves:plan.config.reservedMoves},signal);const power=new MotorEnable(group,[plan]),first=plan.session.clock.sync.getClock(serialClock.now())+200000n;
  const output=(tick:bigint)=>[{id:'x',messages:[],position:1n,history:new BigInt64Array([tick,tick,0n,1n,0n,0n])}];await power.beforeSteps(output(first));
  const start=performance.now(),used=process.cpuUsage();for(let i=1;i<=iterations;i++)await power.beforeSteps(output(first+BigInt(i)));
  const elapsed=(performance.now()-start)/iterations,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000/iterations);}
  assert.equal(fw.outputs.filter(o=>o.name==='queue_digital_out').length,1);if(mode)assert.equal(timeline.status.reservedThrough,first+BigInt(iterations));
 }finally{await group.stop();await fw.close();}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats),limits={medianRatio:1.5,slackMs:.001,p95Ms:.01};
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,iterations,segments:128,variants:['fixedEnable','timelineEnable'],timing,cpu:usage,limits,scope:'Already-enabled beforeSteps hook with native session health and synthetic pulse rows; excludes startup, actual step submission and physical printing.'}));
assert(timing[1].medianMs<timing[0].medianMs*limits.medianRatio+limits.slackMs);assert(usage[1].medianMs<usage[0].medianMs*limits.medianRatio+limits.slackMs);assert(timing[1].p95Ms<limits.p95Ms);
