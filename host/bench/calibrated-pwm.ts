import assert from 'node:assert/strict';
import {GenerationPWMOutput} from '../src/outputs/generation-pwm.ts';
import {compilePWM} from '../src/outputs/pwm.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
import {snapshotPrintClock} from '../src/timing/print-clock.ts';
const dictionary=new MessageDictionary();dictionary.identify(Buffer.from(JSON.stringify({commands:{'config_pwm_out oid=%c pin=%u cycle_ticks=%u value=%hu default_value=%hu max_duration=%u':24,'queue_pwm_out oid=%c clock=%u value=%hu':25,'queue_pwm_out_generation oid=%c clock=%u value=%hu generation=%u':30,'reset_pwm_out_generation oid=%c generation=%u':31},responses:{},config:{CLOCK_FREQ:1e6,PWM_MAX:255}})),false);
const chip={},snapshot=snapshotPrintClock({offset:0,frequency:1e6}),plan=compilePWM(chip,dictionary,{oid:3,pin:{chip,chipName:'mcu',pin:'PA0',invert:0,pullup:0},hardware:true,currentPrintTime:1},snapshot.clockAt),signal=new AbortController().signal,wall:number[][]=[[],[]],cpu:number[][]=[[],[]],writes=10000;
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const clock=new PrintClockTimeline({offset:0,frequency:1e6});for(let i=1;i<128;i++)clock.append(BigInt(i)*1000000n,1e6);
 let sent=0;const queue={async send(){sent++;},async stop(){}},control={async send(){},async stop(){}},output=mode?GenerationPWMOutput.withClock(plan,dictionary,queue,control,clock):new GenerationPWMOutput(plan,dictionary,queue,control,snapshot.clockAt,snapshot.printTimeAtClock);
 await output.reset(signal);const used=process.cpuUsage(),start=performance.now();
 for(let i=0;i<writes;i++)await output.setPWM(128+i*.0001,.5,signal);
 const elapsed=(performance.now()-start)/writes,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000/writes);}
 assert.equal(sent,writes);if(mode)assert.equal(clock.status.reservedThrough,clock.clockAt(128+(writes-1)*.0001));await output.stop();
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats),limits={medianRatio:1.5,slackMs:.001,p95Ms:.01};
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,writes,segments:128,variants:['fixedPWM','reservedTimelinePWM'],timing,cpu:usage,limits,scope:'PWM encoding and immediately resolved sends, includes clock reservation; excludes serial IO and physical output.'}));
assert(timing[1].medianMs<timing[0].medianMs*limits.medianRatio+limits.slackMs);assert(usage[1].medianMs<usage[0].medianMs*limits.medianRatio+limits.slackMs);assert(timing[1].p95Ms<limits.p95Ms);
