import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {rebuiltFixture} from '../test/helpers/rebuilt-motion.ts';
import {GenerationPWMOutput} from '../src/outputs/generation-pwm.ts';
import {ScheduledCoolingFan} from '../src/outputs/fan.ts';
import {FanBoundaryTimeline} from '../src/outputs/fan-boundaries.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {RebuiltMotionStreamer} from '../src/runtime/motion-streamer.ts';
import {Move,LookAheadQueue,motionLimits} from '../src/motion/lookahead.ts';
import {markMoveEnd} from '../src/motion/boundary-markers.ts';
import {inputShaper} from '../src/motion/shaper.ts';
const moveCount=Number(process.env.MOVES??10000);assert([10,10000].includes(moveCount));
const times:number[][]=[[],[]],cpu:number[][]=[[],[]];let reference:Record<string,[bigint,bigint][]>|undefined,maxTickError=0n,steps=0;
for(let run=0;run<14;run++)for(const bound of run%2?[1,0]:[0,1]){
 const f=await rebuiltFixture(false,false,true),signal=new AbortController().signal;let timeline:FanBoundaryTimeline|undefined;
 try{
  const group=f.options.group,b=f.options.motion.bindings[0],session=group.session('m'),pwm=new GenerationPWMOutput(f.fanPlan!,session.dictionary,group.commandQueue('m'),group.commandQueue('m'),t=>b.stepper.clockAt(t),c=>b.stepper.printTimeAtClock(c));
  const fan=new ScheduledCoolingFan(pwm,{kickStartTime:0,minimumScheduleTime:.001});await fan.start(signal);timeline=new FanBoundaryTimeline(fan);
  const g=await bindRebuiltMotion({...f.options,...bound?{boundaryOutput:{output:timeline,member:0}}:{}}),[x,e]=g.motion.bindings;
  x.stepper.configureShapers({x:inputShaper('mzv',40,.1)});e.stepper.configurePressureAdvance(.05,.04);
  const q=new LookAheadQueue();for(let i=0;i<moveCount;i++){const m=new Move(motionLimits(100,1000),[50+i*2/moveCount,0,0,2+i*.1/moveCount],[50+(i+1)*2/moveCount,0,0,2+(i+1)*.1/moveCount],10);if(bound&&(i+1)%(moveCount/10)===0)markMoveEnd(m,timeline.register(((i+1)/(moveCount/10)-1)%2?.5:.25));q.add(m);}const moves=q.flush();
  const ticks:Record<string,[bigint,bigint][]>=Object.fromEntries(g.motion.bindings.map(b=>[b.id,[]]));let start=0;const startAt=g.source.startAt.bind(g.source);g.source.startAt=time=>{start=time;startAt(time);};
  for(const b of g.motion.bindings){const flush=b.stepper.flushThrough.bind(b.stepper);b.stepper.flushThrough=time=>{const out=flush(time);for(let i=0;i<out.history.length;i+=6){const [first,,position,count,interval,add]=out.history.slice(i,i+6),n=count<0n?-count:count;for(let j=0n;j<n;j++)ticks[b.id].push([first+j*interval+add*j*(j+1n)/2n-b.stepper.clockAt(start),position+(count<0n?-1n:1n)*(j+1n)]);}return out;};}
  const used=process.cpuUsage(),begin=performance.now();await new RebuiltMotionStreamer(g).append(moves,signal);const endpoint=g.source.status.sourceTime;await g.source.drain([],signal);const elapsed=performance.now()-begin,usage=process.cpuUsage(used);
  assert.equal(x.history.status.lastPlannedPosition,300n);assert.equal(e.history.status.lastPlannedPosition,30n);assert.equal(f.stops,0);
  const writes=f.fw.outputs.filter(m=>m.name==='queue_pwm_out_generation');assert.equal(writes.length,bound?10:0);if(bound){assert.deepEqual(writes.map(m=>m.parameters.value),Array.from({length:10},(_,i)=>i%2?128:64));assert.equal(Number(writes.at(-1)!.parameters.clock),Number(BigInt.asUintN(32,x.stepper.clockAt(endpoint))));}
  for(const rows of Object.values(ticks))rows.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  if(!reference){reference=ticks;steps=Object.values(ticks).reduce((n,t)=>n+t.length,0);}else for(const id of Object.keys(reference)){assert.equal(ticks[id].length,reference[id].length);for(let i=0;i<ticks[id].length;i++){assert.equal(ticks[id][i][1],reference[id][i][1]);const d:bigint=ticks[id][i][0]-reference[id][i][0],error:bigint=d<0n?-d:d;assert(error<=1n);if(error>maxTickError)maxTickError=error;}}
  if(run>=3){times[bound].push(elapsed);cpu[bound].push((usage.user+usage.system)/1000);}
 }finally{await f.close();await timeline?.stop();}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};const timing=times.map(stats),usage=cpu.map(stats);
console.log(JSON.stringify({node:process.version,samples:11,moves:moveCount,fanRequests:10,variants:['motion','motionAndFan'],timing,cpu:usage,stepsCompared:steps,maxTickError:String(maxTickError),scope:'Native MZV/pressure advance, motion and PWM over serial emulator, MCU clock drain; no physical hardware acceptance.'}));
assert(timing[1].medianMs<=timing[0].medianMs*1.1+10,'Fan integration wall time regression');assert(usage[1].medianMs<=usage[0].medianMs*1.5+3,'Fan integration CPU regression');
