import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {idleMotionFixture} from '../test/helpers/idle-motion.ts';
import {LookAheadQueue,Move,motionLimits} from '../src/motion/lookahead.ts';
import {markPressureBoundary} from '../src/motion/pressure-boundaries.ts';
const planner=new LookAheadQueue(),limits=motionLimits(100,100,5,0);
for(let i=0;i<200;i++)planner.add(new Move(limits,[50+i,0,0,2+i*.1],[51+i,0,0,2+(i+1)*.1],10));
const moves=planner.flush();for(let i=0;i<moves.length;i++)markPressureBoundary(moves[i],{stepper:'e',advance:i%2?.05:.1});
const elapsed:number[][]=[[],[]],query:number[]=[];let reference:unknown;
for(let round=0;round<14;round++)for(const automatic of round%2?[1,0]:[0,1]){
 const f=idleMotionFixture(true);try{
  f.source.startAt(1);const signal=new AbortController().signal,start=performance.now();
  if(automatic)await f.source.drain(moves,signal);
  else{for(let i=0;i<moves.length;i+=20){f.source.append(moves.slice(i,i+20));await f.source.flushThrough(f.source.status.sourceTime,signal);}await f.source.drain([],signal);}
  const ms=performance.now()-start;if(round>=3)elapsed[automatic].push(ms);
  for(const ticks of Object.values(f.ticks))ticks.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  const result={ticks:f.ticks,positions:f.positions,filters:f.e.recoveryFilters()};if(reference===undefined)reference=structuredClone(result);else assert.deepEqual(result,reference);assert.equal(f.stops,0);
 }finally{f.close();}
}
for(let round=0;round<14;round++){
 const f=idleMotionFixture(true);try{const changes=Array.from({length:200},(_,i)=>({time:1+i*.1,advance:i%2?.05:.1})),start=performance.now();for(let i=0;i<10000;i++)assert.equal(f.e.pressureSchedulePrefix(changes),127);if(round>=3)query.push(performance.now()-start);}finally{f.close();}
}
for(const times of [...elapsed,query])times.sort((a,b)=>a-b);
assert(elapsed[1][5]!<=elapsed[0][5]!*1.25+2);assert(elapsed[1][10]!<=elapsed[0][10]!*1.5+2);
console.log(JSON.stringify({node:process.version,moves:200,samples:11,allPulsesExact:true,automaticMedianMs:elapsed[1][5],automaticP95Ms:elapsed[1][10],smallBatchMedianMs:elapsed[0][5],smallBatchP95Ms:elapsed[0][10],query200UpdatesMedianUs:query[5]!/10,query200UpdatesP95Us:query[10]!/10,scope:'native generation and pressure admission with memory sink; no hardware timing'},null,2));
