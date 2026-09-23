import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {idleMotionFixture,idleTestMove} from '../test/helpers/idle-motion.ts';
const elapsed:number[][]=[[],[]],cpu:number[][]=[[],[]],commits:number[]=[];let reference:Record<string,[bigint,bigint][]>|undefined,maxTickError=0n,steps=0;
for(let round=0;round<14;round++)for(const fast of round%2?[1,0]:[0,1]){
 const f=idleMotionFixture(true);try{
  const used=process.cpuUsage(),start=performance.now();f.source.startAt(3600);if(fast)await f.source.prepareIdle(new AbortController().signal);await f.source.drain(idleTestMove(),new AbortController().signal);const ms=performance.now()-start,usage=process.cpuUsage(used);
  assert.deepEqual(f.positions,{x:200n,e:30n});assert.equal(f.stops,0);commits[fast]=f.commits;
  for(const rows of Object.values(f.ticks))rows.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  if(!reference){reference=structuredClone(f.ticks);steps=Object.values(reference).reduce((n,t)=>n+t.length,0);}else for(const id of Object.keys(reference)){assert.equal(f.ticks[id].length,reference[id].length);for(let i=0;i<f.ticks[id].length;i++){assert.equal(f.ticks[id][i][1],reference[id][i][1]);const d:bigint=f.ticks[id][i][0]-reference[id][i][0],error:bigint=d<0n?-d:d;assert(error<=1n);if(error>maxTickError)maxTickError=error;}}
  if(round>=3){elapsed[fast].push(ms);cpu[fast].push((usage.user+usage.system)/1000);}
 }finally{f.close();}
}
for(const a of [...elapsed,...cpu])a.sort((a,b)=>a-b);const stats=(a:number[])=>({medianMs:a[5],p95Ms:a[10]});
console.log(JSON.stringify({node:process.version,samples:11,idleSeconds:3600,stepsCompared:steps,maxTickError:String(maxTickError),windowed:{elapsed:stats(elapsed[0]),cpu:stats(cpu[0]),commits:commits[0]},idleAdvance:{elapsed:stats(elapsed[1]),cpu:stats(cpu[1]),commits:commits[1]},scope:'one-hour stationary coverage and one shaped XYZ/pressure-advance move; real native generation, memory sink; no MCU or physical idle waiting'}));
assert(elapsed[1][5]<elapsed[0][5]*.1,'Idle advance must remove at least 90% of windowed preparation time');assert(elapsed[1][5]<5,'Idle advance median exceeds 5ms desktop budget');
