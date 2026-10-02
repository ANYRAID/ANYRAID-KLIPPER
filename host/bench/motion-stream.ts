import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {trajectory} from '../test/helpers/motion-stream.ts';
let maxTickDifference=0n,steps=0;
for(const kind of [0,1]){const a=await trajectory(kind,true),b=await trajectory(kind,false);assert.equal(a.position,b.position);assert.equal(a.ticks.length,b.ticks.length);steps+=a.ticks.length;for(let i=0;i<a.ticks.length;i++){assert.equal(a.ticks[i].position,b.ticks[i].position);const d=a.ticks[i].clock-b.ticks[i].clock,absolute=d<0n?-d:d;assert.ok(absolute<=1n);if(absolute>maxTickDifference)maxTickDifference=absolute;}}
const times:number[]=[];for(let i=0;i<16;i++){const start=performance.now();for(let j=0;j<100;j++)await trajectory(j%2,true,false);if(i>=5)times.push(performance.now()-start);}times.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,runsPerBatch:100,stepsCompared:steps,maxTickDifference:String(maxTickDifference),medianMs:times[5],p95Ms:times[10],scope:'Two rolling source windows plus final drain, native shaping/pressure advance, in-memory sink. Includes setup; excludes serial, firmware wait and physical motion. Compared with whole-trajectory native generation.'},null,2));
