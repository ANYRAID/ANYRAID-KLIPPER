import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {ClockSync} from '../src/timing/clock-sync.ts';
import {waitForMcuClocks} from '../src/timing/mcu-clock-barrier.ts';
const base=1n<<54n,signal=new AbortController().signal,targets=Array.from({length:3},()=>({clock:{sync:new ClockSync(1000000,base+10n,1),assertActive(){}},tick:base+9n})),times:number[]=[];let checks=0;
for(const t of targets)t.clock.assertActive=()=>{checks++;};
for(let i=0;i<16;i++){const start=performance.now();for(let j=0;j<10000;j++)await waitForMcuClocks(targets,signal);if(i>=5)times.push(performance.now()-start);}assert.equal(checks,16*10000*3*2);times.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,mcus:3,barriersPerBatch:10000,medianMs:times[5],p95Ms:times[10],scope:'Already-passed 64-bit sampled clocks; real ClockSync objects with health-check counters. No polling delay, serial ACK, physical motion or equal-work Python counterpart.'},null,2));
