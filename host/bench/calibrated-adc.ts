import assert from 'node:assert/strict';
import {ADCInput,compileADC,batchADCQuery} from '../src/inputs/adc.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
const d=new MessageDictionary();d.identify(Buffer.from(JSON.stringify({commands:{'config_analog_in oid=%c pin=%u':27,[batchADCQuery]:28},responses:{'analog_in_state oid=%c next_clock=%u values=%*s':29},config:{CLOCK_FREQ:1e6,ADC_MAX:4095}})),false);
const chip={},plan=compileADC(chip,d,{oid:3,pin:{chip,chipName:'mcu',pin:'PA0',invert:0,pullup:0},currentPrintTime:1,reportTime:.003,sampleTime:.001,sampleCount:1,batchCount:24},t=>BigInt(Math.round(t*1e6))),reports=10000,wall:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const clock=new PrintClockTimeline({offset:0,frequency:1e6});for(let i=1;i<128;i++)clock.append(BigInt(i)*1000000n,1e6);
 let samples=0;const callback=(batch:readonly (readonly [number,number])[])=>{samples+=batch.length;},input=mode?ADCInput.withClock(plan,BigInt,clock,callback):new ADCInput(plan,BigInt,t=>Number(t)/1e6,callback),values=Buffer.alloc(48),used=process.cpuUsage(),start=performance.now();
 for(let i=0;i<reports;i++)input.receive({name:'analog_in_state',parameters:{oid:3,next_clock:128000000+(i+1)*72000,values}});
 const elapsed=(performance.now()-start)/(reports*24),usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000/(reports*24));}
 assert.equal(samples,reports*24);input.close();
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats),limits={wallP95Ms:.005,cpuMedianMs:.005};
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,reports,batch:24,segments:128,variants:['fixedADC','retainedHistoryADC'],timing,cpu:usage,limits,scope:'Per decoded sample including batch validation, history mapping and lease advancement; no serial IO or thermistor conversion.'}));
assert(timing[1].p95Ms<limits.wallP95Ms);assert(usage[1].medianMs<limits.cpuMedianMs);
