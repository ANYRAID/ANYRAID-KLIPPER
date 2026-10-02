import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import {readFileSync} from 'node:fs';
import {max6675Temperature} from '../src/thermal/max6675.ts';
import {AsyncHeaterRuntime} from '../src/thermal/async-runtime.ts';
import {HeaterRuntime} from '../src/thermal/runtime.ts';
import {PIDControl} from '../src/thermal/control.ts';
const samples=20000,config={minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3};
// Frozen original callback outputs and timing; no Python process in routine runs.
const oracle=JSON.parse(readFileSync(new URL('../contracts/async-heater-pid-reference.json',import.meta.url),'utf8')) as {result:number[][];times:number[]};
async function run(asynchronous:boolean,digital=false){
 let time=0,tick=()=>{};const output:number[][]=[],control=new PIDControl({kp:22,ki:1.08,kd:114,smoothTime:1,maxPower:1});
 const clock=()=>({system:time,print:time}),timer=(callback:()=>void)=>{tick=callback;return ()=>{};};
 const runtime=asynchronous?new AsyncHeaterRuntime(config,control,{configuration:{cycleTime:.1,maximumDuration:3,defaultPower:0,initialPower:0},reset:async()=>{},setPWM:async(t,v)=>{output.push([t,v]);},stop:async()=>{}},clock,{},timer):new HeaterRuntime(config,control,{configureMaximumDuration:()=>{},turnOff:()=>{},schedule:(t,v)=>{output.push([t,v]);}},clock,{},timer);
 await runtime.start();runtime.sample(.1,digital?max6675Temperature(200*32):200);await runtime.setTarget(200);
 for(let i=2;i<samples+2;i++){
  time=i*.1;runtime.sample(time,digital?max6675Temperature(198*32):198);if(i%10===0)tick();
  // Same microtask service opportunities for both paths; no simulated UART time.
  if(i%16===0){await Promise.resolve();await Promise.resolve();}
 }
 assert.equal(runtime.status.stopped,false);await runtime.shutdown();return output;
}
assert.deepEqual(await run(false),oracle.result);assert.deepEqual(await run(true),oracle.result);assert.deepEqual(await run(true,true),oracle.result);
for(let i=0;i<3;i++){await run(false);await run(true);await run(true,true);}
const sync:number[]=[],async:number[]=[],spi:number[]=[];
for(let i=0;i<11;i++)for(const variant of i%2?[2,1,0]:[0,1,2]){const start=performance.now();await run(variant!==0,variant===2);([sync,async,spi][variant]).push(performance.now()-start);}
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[5],p95Ms:values[10]};};
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,samples,pwmWrites:oracle.result.length,outputExact:true,python:stats(oracle.times),synchronous:stats(sync),acknowledged:stats(async),spiFeedback:stats(spi),extraNanosecondsPerSample:(async[5]-sync[5])*1e6/samples,pythonToAcknowledgedSpeedup:oracle.times[5]/async[5],scope:'Fixed historical Python callback reference, immediate fake ACK, microtask drain, pure thermal control including MAX6675 decode; excludes UART latency, SPI electrical timing and hardware deadlines'},null,2));
assert.ok(async[5]<=oracle.times[5],'Acknowledged thermal runtime regressed against Python');
assert.ok(spi[5]<=oracle.times[5],'SPI thermal runtime regressed against historical Python');
