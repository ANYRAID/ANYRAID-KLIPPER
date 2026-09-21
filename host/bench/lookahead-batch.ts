import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {Move,LookAheadQueue,motionLimits} from '../src/motion/lookahead.ts';
const limits=motionLimits(300,3000);
function run(batch:boolean){const q=new LookAheadQueue();let checksum=0,count=0;for(let n=0;n<1000;n++){const moves=Array.from({length:20},(_,i)=>new Move(limits,[i,0,0,0],[i+1,0,0,.01],100));if(batch)q.addBatch(moves);else for(const m of moves)q.add(m);for(const m of q.flush()){checksum+=m.profile!.cruiseT+m.profile!.accelT+m.profile!.decelT;count++;}}return {checksum,count};}
const runReference=reference();
const sequential:number[]=[],batch:number[]=[];for(let k=0;k<16;k++){for(const mode of k%2?[true,false]:[false,true]){const start=performance.now();const result=run(mode);if(k>=5)(mode?batch:sequential).push(performance.now()-start);assert.equal(result.count,20000);assert.ok(Math.abs(result.checksum-runReference)<1e-9);}}
function reference(){return run(false).checksum;}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};console.log(JSON.stringify({node:process.version,moves:20000,batchSize:20,sequential:stats(sequential),atomicBatch:stats(batch),scope:'Alternating order, 5 warmup and 11 measured rounds; includes Move creation, junctions and full flush. Matching profile duration checksum. Desktop only.'},null,2));
