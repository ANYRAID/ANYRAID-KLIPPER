import assert from 'node:assert/strict';
import {idleMotionFixture} from '../test/helpers/idle-motion.ts';
import {Move,LookAheadQueue,motionLimits} from '../src/motion/lookahead.ts';
import {dwellMove} from '../src/motion/dwell.ts';
import {stationaryRows} from '../src/motion/stationary.ts';
const limits=motionLimits(100,1000),signal=new AbortController().signal;
function move(a:number[],b:number[]){const queue=new LookAheadQueue();queue.add(new Move(limits,a,b,10));return queue.flush();}
async function run(planned:boolean,filtered:boolean,duration:number){
 const f=idleMotionFixture(filtered),a=[50,0,0,2],b=[51,0,0,2.1],c=[50,0,0,2.2],before=move(a,b),after=move(b,c);
 try{if(planned){f.source.startAt(1);await f.source.drain([...before,dwellMove(limits,b,duration),...after],signal);}else{
  for(const [queue,axis] of [[f.xyz,undefined],[f.equeue,3]] as const){const point=(p:number[])=>axis===undefined?p.slice(0,3):[p[axis],0,0];queue.appendRaw(stationaryRows(0,1,point(a)));const end=queue.appendPlanned(before,1,axis,true);queue.appendRaw(stationaryRows(end,end+duration,point(b)));queue.appendPlanned(after,end+duration,axis,true);}
  const p=before[0].profile!,q=after[0].profile!,end=((((((1+p.accelT)+p.cruiseT)+p.decelT)+duration)+q.accelT)+q.cruiseT)+q.decelT;await f.coordinator.drain(end,new Map([[f.xyz,[c[0],0,0] as const],[f.equeue,[c[3],0,0] as const]]),.25);
 }assert.equal(f.stops,0);return {ticks:f.ticks,positions:f.positions};}finally{f.close();}
}
let steps=0,maxTickDifference=0n;for(const filtered of [false,true])for(const duration of [.001,.025,.2,1.5]){const a=await run(false,filtered,duration),b=await run(true,filtered,duration);assert.deepEqual(a.positions,b.positions);for(const axis of ['x','e']){assert.equal(a.ticks[axis].length,b.ticks[axis].length);for(let i=0;i<a.ticks[axis].length;i++){assert.equal(a.ticks[axis][i][1],b.ticks[axis][i][1]);const d=a.ticks[axis][i][0]-b.ticks[axis][i][0],abs=d<0n?-d:d;assert(abs<=1n);if(abs>maxTickDifference)maxTickDifference=abs;steps++;}}}
const times:number[][]=[[],[]];for(let sample=0;sample<14;sample++)for(const variant of sample%2?[1,0]:[0,1]){const start=performance.now();for(let i=0;i<100;i++)await run(!!variant,!!(i%2),.025);if(sample>=3)times[variant].push(performance.now()-start);}for(const time of times)time.sort((a,b)=>a-b);const timing=times.map(t=>({medianMs:t[5],p95Ms:t[10]})),limitsTiming={medianRatio:1.25,p95Ratio:1.5,slackMs:2};console.log(JSON.stringify({node:process.version,stepsCompared:steps,maxTickDifference:String(maxTickDifference),warmup:3,samples:11,runs:100,variants:['directNativeStationaryRows','plannedDwellSource'],timing,limits:limitsTiming,scope:'Native XYZE trajectory generation with shaper and pressure advance; compares direct stationary trapq rows against owned planned dwell. Memory sink; excludes UART and physical timing.'}));assert(timing[1].medianMs<=timing[0].medianMs*limitsTiming.medianRatio+limitsTiming.slackMs);assert(timing[1].p95Ms<=timing[0].p95Ms*limitsTiming.p95Ratio+limitsTiming.slackMs);
