import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {RebuiltMotionStreamer} from '../src/runtime/motion-streamer.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {LookAheadQueue,Move,motionLimits} from '../src/motion/lookahead.ts';
import {inputShaper} from '../src/motion/shaper.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {rebuiltFixture} from '../test/helpers/rebuilt-motion.ts';
const times:number[][]=[[],[]],cpu:number[][]=[[],[]];let reference:Record<string,[bigint,bigint][]>|undefined,maxTickError=0n,steps=0;
for(let round=0;round<14;round++)for(const paced of round%2?[1,0]:[0,1]){
 const f=await rebuiltFixture();
 try{
  const g=await bindRebuiltMotion(f.options),s=new AbortController().signal,[x,e]=g.motion.bindings;
  x.stepper.configureShapers({x:inputShaper('mzv',40,.1)});e.stepper.configurePressureAdvance(.05,.04);
  const q=new LookAheadQueue(),limits=motionLimits(100,1000);for(let i=0;i<20;i++)q.add(new Move(limits,[50+i,0,0,2+i/50],[51+i,0,0,2+(i+1)/50],20));const moves=q.flush();
  const ticks:Record<string,[bigint,bigint][]>=Object.fromEntries(g.motion.bindings.map(b=>[b.id,[]]));let start=0;
  const startAt=g.source.startAt.bind(g.source);g.source.startAt=time=>{start=time;startAt(time);};
  for(const b of g.motion.bindings){const flush=b.stepper.flushThrough.bind(b.stepper);b.stepper.flushThrough=time=>{const out=flush(time);for(let i=0;i<out.history.length;i+=6){const [first,,position,count,interval,add]=out.history.slice(i,i+6),n=count<0n?-count:count;for(let j=0n;j<n;j++)ticks[b.id].push([first+j*interval+add*j*(j+1n)/2n-b.stepper.clockAt(start),position+(count<0n?-1n:1n)*(j+1n)]);}return out;};}
  const used=process.cpuUsage(),begin=performance.now();
  if(paced)await new RebuiltMotionStreamer(g).append(moves,s);
  else{const padding=Math.max(.001,...g.motion.bindings.flatMap(b=>[b.stepper.scanWindow.future,b.stepper.scanWindow.past]));g.source.startAt(Math.max(g.source.status.sourceTime+padding+.001,x.stepper.printTimeAtClock(g.members[0].session.clock.sync.getClock(serialClock.now()))+.2+padding));}
  await g.source.drain(paced?[]:moves,s);const elapsed=performance.now()-begin,usage=process.cpuUsage(used);
  assert.equal(x.history.status.lastPlannedPosition,2100n);assert.equal(e.history.status.lastPlannedPosition,60n);assert.equal(f.stops,0);
  for(const rows of Object.values(ticks))rows.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  if(!reference){reference=ticks;steps=Object.values(ticks).reduce((n,t)=>n+t.length,0);}
  else for(const id of Object.keys(reference)){assert.equal(ticks[id].length,reference[id].length);for(let i=0;i<ticks[id].length;i++){assert.equal(ticks[id][i][1],reference[id][i][1]);const d:bigint=ticks[id][i][0]-reference[id][i][0],error:bigint=d<0n?-d:d;assert(error<=1n,`${id} pulse ${i} differs by ${error} ticks`);if(error>maxTickError)maxTickError=error;}}
  if(round>=3){times[paced].push(elapsed);cpu[paced].push((usage.user+usage.system)/1000);}
 }finally{await f.close();}
}
for(const a of [...times,...cpu])a.sort((a,b)=>a-b);const stats=(a:number[])=>({medianMs:a[5],p95Ms:a[10]});
console.log(JSON.stringify({node:process.version,samples:11,moves:20,stepsCompared:steps,maxTickError:String(maxTickError),direct:{elapsed:stats(times[0]),cpu:stats(cpu[0])},paced:{elapsed:stats(times[1]),cpu:stats(cpu[1])},scope:'MZV and pressure advance native generation, real Unix transport and MCU-clock wait; initialization excluded; relative pulse clocks normalized to nominal start; no physical hardware'}));
assert(times[1][5]<=times[0][5]*1.1,'Pacing median elapsed exceeds direct drain by 10%');assert(cpu[1][5]<=cpu[0][5]*2+3,'Pacing median CPU exceeds twice direct plus 3ms');assert(cpu[1][5]<20,'Pacing median CPU exceeds 20ms desktop budget');
