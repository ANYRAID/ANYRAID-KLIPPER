import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {heaterFanSpeed} from '../src/thermal/heater-fan.ts';
const policy={heaters:Array.from({length:64},(_,i)=>String(i)),threshold:50,speed:1},state={temperature:25,target:0,stale:false},read=()=>state,times:number[]=[];
for(let sample=0;sample<14;sample++){
 const start=performance.now();let sum=0;
 for(let tick=0;tick<1000;tick++)for(let fan=0;fan<64;fan++)sum+=heaterFanSpeed(policy,read);
 const elapsed=performance.now()-start;assert.equal(sum,0);if(sample>=3)times.push(elapsed);
}
times.sort((a,b)=>a-b);assert(times[10]<1000,'Maximum thermal fan fleet exceeds 1ms per polling cycle');
console.log(JSON.stringify({node:process.version,fans:64,heatersPerFan:64,pollingCyclesPerSample:1000,samples:11,medianMs:times[5],p95Ms:times[10],p95PerFleetPollMs:times[10]/1000,scope:'Pure temperature policy on desktop; excludes serial IO and target-board scheduling'}));
