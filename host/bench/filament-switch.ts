import assert from 'node:assert/strict';
import {FilamentSwitch} from '../src/inputs/filament-switch.ts';
// Full debounce callbacks and printing-state admission, synthetic monotonic clock.
// Physical MCU sampling, transport and mechanical pause latency are excluded.
const durations:number[]=[];
for(let run=0;run<13;run++){
 let now=0,callback:(time:number,present:boolean)=>void=()=>{},scheduled:(()=>void)|undefined,pauses=0;
 const sensor=new FilamentSwitch({status:{received:false,present:false,time:undefined},subscribe(fn){callback=fn;return ()=>{};}},{debounce:.01,eventDelay:3,pause:true},{now:()=>now,schedule(fn){scheduled=fn;return ()=>{scheduled=undefined;};}},()=>false,async()=>{pauses++;},error=>{throw error;});
 const begin=performance.now();for(let i=0;i<20000;i++){now=3+i*.02;callback(now,!!(i%2));now+=.01;const fire=scheduled;scheduled=undefined;assert(fire);fire();assert.equal(sensor.status.filament_detected,!!(i%2));}const elapsed=performance.now()-begin;sensor.close();assert.equal(pauses,0);assert.equal(scheduled,undefined);if(run>=2)durations.push(elapsed);
}
durations.sort((a,b)=>a-b);const result={node:process.version,events:20000,samples:durations.length,medianMs:durations[5],p95Ms:durations[10],scope:'Debounce and idle admission; synthetic timer; exact 20000 state transitions; excludes physical pause latency'};assert(result.p95Ms<1000);console.log(JSON.stringify(result,null,2));
