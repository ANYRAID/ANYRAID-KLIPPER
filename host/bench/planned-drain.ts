import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
import type {CoordinatedMotionDrain} from '../src/motion/coordinated-drain.ts';
import {PlannedMotionSource} from '../src/motion/planned-motion-source.ts';
import {Move,motionLimits} from '../src/motion/lookahead.ts';
import {inputShaper} from '../src/motion/shaper.ts';
const moveCount=Number(process.env.PLANNED_DRAIN_MOVES??500);if(!Number.isSafeInteger(moveCount)||moveCount<1||moveCount>10000)throw new RangeError('Invalid benchmark move count');
const limits=motionLimits(100,1000),moves:Move[]=[];let p=[0,0,0,0];
for(let i=0;i<moveCount;i++){const next=[...p];if(i%3!==1)next[0]++;if(i%3!==2)next[3]+=.1;const m=new Move(limits,p,next,10);m.setJunction(0,100,0);moves.push(m);p=next;}
async function run(capacity:number,capture:boolean){
 using xyz=new TrapQueue();using extrusion=new TrapQueue();const settings={frequency:1e6,timeOffset:0,maxError:0,queueStepTag:5,directionTag:6};using x=xyz.createStepper({...settings,oid:3},'x',.01);using e=extrusion.createStepper({...settings,oid:4},'extruder',.01);x.configureShapers({x:inputShaper('mzv',40,.1)});e.configurePressureAdvance(.05,.04);
 const ticks:Record<string,[bigint,bigint][]>= {x:[],e:[]},positions:Record<string,bigint>={};
 const c=new MotionCoordinator([{id:'x',queue:xyz,stepper:x},{id:'e',queue:extrusion,stepper:e}],{async commit(b){for(const out of b.outputs){positions[out.id]=out.position;if(capture)for(let i=0;i<out.history.length;i+=6){const [first,,start,count,interval,add]=out.history.slice(i,i+6),n=count<0n?-count:count;for(let j=0n;j<n;j++)ticks[out.id].push([first+j*interval+add*j*(j+1n)/2n,start+(count<0n?-1n:1n)*(j+1n)]);}}},async stop(){}});
 // Deliberately exclude MCU lifecycle/I/O: retain the real native coordinator
 // while substituting only the device-wait adapter for this CPU benchmark.
 const driver={get generatedTime(){return c.status.generatedTime;},usesQueues:(queues:readonly TrapQueue[])=>c.usesQueues(queues),get finalizedSourceTime(){return c.finalizedSourceTime;},advanceSource:(time:number)=>c.advanceSource(time,0,.25),drain:(time:number,endpoints:ReadonlyMap<TrapQueue,readonly [number,number,number]>)=>c.drain(time,endpoints,.25),stop:(error:unknown)=>c.shutdown(error)} as unknown as CoordinatedMotionDrain;
 const source=new PlannedMotionSource([{queue:xyz},{queue:extrusion,extrusionAxis:3}],driver,1,[0,0,0,0],capacity),start=performance.now();await source.drain(moves,new AbortController().signal);const elapsed=performance.now()-start;assert.equal(source.status.bufferedMoves,0);
 for(const t of Object.values(ticks))t.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);return {ticks,positions,elapsed};
}
let steps=0,maxDelta=0n;{const a=await run(32,true),b=await run(65536,true);assert.deepEqual(a.positions,b.positions);for(const axis of ['x','e']){assert.equal(a.ticks[axis].length,b.ticks[axis].length);steps+=a.ticks[axis].length;for(let i=0;i<a.ticks[axis].length;i++){assert.equal(a.ticks[axis][i][1],b.ticks[axis][i][1]);const d=a.ticks[axis][i][0]-b.ticks[axis][i][0],absolute=d<0n?-d:d;assert.ok(absolute<=1n);if(absolute>maxDelta)maxDelta=absolute;}}}
const times:{chunked:number[];whole:number[]}={chunked:[],whole:[]};for(let i=0;i<16;i++)for(const mode of i%2?['chunked','whole'] as const:['whole','chunked'] as const){const result=await run(mode==='chunked'?32:65536,false);if(i>=5)times[mode].push(result.elapsed);}for(const values of Object.values(times))values.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,moves:moveCount,chunkCapacity:32,stepsCompared:steps,maxTickDifference:String(maxDelta),chunkedMedianMs:times.chunked[5],chunkedP95Ms:times.chunked[10],wholeMedianMs:times.whole[5],wholeP95Ms:times.whole[10],scope:'Owned suffix snapshot, source ring admission/release, native shaped XYZ and pressure-advance generation, memory sink. Device lifecycle/serial/MCU completion replaced by adapter; not physical performance.'},null,2));
