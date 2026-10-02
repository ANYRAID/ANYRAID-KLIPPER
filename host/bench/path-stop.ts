import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {Move,LookAheadQueue,motionLimits} from '../src/motion/lookahead.ts';
import {planPathStop} from '../src/motion/path-stop.ts';
const limits=motionLimits(100,100,5,0),queue=new LookAheadQueue();
for(let i=0;i<10000;i++)queue.add(new Move(limits,[i,0,0,i*.1],[i+1,0,0,(i+1)*.1],10));
const moves=queue.flush(),elapsed:number[]=[],cpu:number[]=[];let segments=0;
for(let i=0;i<14;i++){
 const used=process.cpuUsage(),start=performance.now(),result=planPathStop(moves,500),ms=performance.now()-start,usage=process.cpuUsage(used);
 assert(Math.abs(result.position[0]-5000)<1e-8);assert(Math.abs(result.position[3]-500)<1e-8);assert.equal(result.brake.at(-1)!.profile!.endV,0);assert.deepEqual(result.remainder.at(-1)!.endPos,[10000,0,0,1000]);segments=result.brake.length;
 if(i>=3){elapsed.push(ms);cpu.push((usage.user+usage.system)/1000);}
}
elapsed.sort((a,b)=>a-b);cpu.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,moves:moves.length,samples:11,brakingSegments:segments,elapsed:{medianMs:elapsed[5],p95Ms:elapsed[10]},cpu:{medianMs:cpu[5],p95Ms:cpu[10]},scope:'validate 10000 planned segments, locate anchor, compute brake and own 5000-segment restart suffix; no I/O or physical pause'}));
assert(elapsed[5]<25,'Path stop planning exceeds 25ms desktop median budget for 10000 segments');
