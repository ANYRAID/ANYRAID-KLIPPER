import assert from 'node:assert/strict';
import {planArc,arcSegment,type ArcPlane} from '../src/gcode/arcs.ts';
import {GCodeMove,type Parameters} from '../src/gcode/move.ts';
import {Move,LookAheadQueue,motionLimits} from '../src/motion/lookahead.ts';
import {idleMotionFixture} from '../test/helpers/idle-motion.ts';
import {arcsReference} from '../test/helpers/arcs-reference.ts';
const {origin,cases,reference}=arcsReference,iterations=400;
function run(index:number){const c=cases[index],p=planArc(origin,c.absolute,c.params,c.clockwise,c.plane,c.resolution);return Array.from({length:p.segments},(_,i)=>arcSegment(p,i));}
let maxCoordinateError=0,segmentsCompared=0,stepsCompared=0,maxTickDifference=0n;
async function native(params:readonly Parameters[],absolute:boolean,filtered:boolean){const f=idleMotionFixture(filtered),q=new LookAheadQueue(),limits=motionLimits(100,1000);let position=[...origin];const gcode=new GCodeMove({position:()=>position,move:(p,speed)=>{q.add(new Move(limits,position,p,speed));position=[...p];}});if(!absolute)gcode.execute('M83');try{for(const p of params)gcode.execute('G1',p);f.source.startAt(1);await f.source.drain(q.flush(),new AbortController().signal);assert.equal(f.stops,0);return {ticks:f.ticks,positions:f.positions};}finally{f.close();}}
for(let i=0;i<cases.length;i++){
 const actual=run(i),expected=reference.results[i];assert.equal(actual.length,expected.length);segmentsCompared+=actual.length;
 for(let j=0;j<actual.length;j++){assert.deepEqual(Object.keys(actual[j]).sort(),Object.keys(expected[j]).sort());for(const key of Object.keys(expected[j])){const error=Math.abs(Number(actual[j][key])-expected[j][key]);assert(error<=1e-12*Math.max(1,Math.abs(expected[j][key])));maxCoordinateError=Math.max(error,maxCoordinateError);}}
 for(const filtered of [false,true]){const a=await native(expected,cases[i].absolute,filtered),b=await native(actual,cases[i].absolute,filtered);assert.deepEqual(a.positions,b.positions);for(const axis of ['x','e']){assert.equal(a.ticks[axis].length,b.ticks[axis].length);for(let j=0;j<a.ticks[axis].length;j++){assert.equal(a.ticks[axis][j][1],b.ticks[axis][j][1]);const delta=a.ticks[axis][j][0]-b.ticks[axis][j][0],abs=delta<0n?-delta:delta;assert(abs<=1n);if(abs>maxTickDifference)maxTickDifference=abs;stepsCompared++;}}}
}
let checksum=0;const times:number[]=[];for(let sample=0;sample<14;sample++){const start=performance.now();for(let i=0;i<iterations;i++)checksum+=run(i%cases.length).length;if(sample>=3)times.push(performance.now()-start);}times.sort((a,b)=>a-b);assert.equal(checksum,reference.checksum);
const limits={medianRatio:1.25,p95Ratio:1.5,slackMs:2};console.log(JSON.stringify({node:process.version,cases:cases.length,segmentsCompared,maxCoordinateError,stepsCompared,maxTickDifference:String(maxTickDifference),iterations,warmup:3,samples:11,nodeArc:{medianMs:times[5],p95Ms:times[10]},pythonArc:{medianMs:reference.times[5],p95Ms:reference.times[10]},limits,scope:'Frozen original Python arc commands versus TS geometry and parameter creation, followed by native X/E pulses with shaping and pressure advance. Python timing is the recorded extraction baseline, not rerun. Memory sink; excludes UART and real printer timing.'}));
assert(times[5]<=reference.times[5]*limits.medianRatio+limits.slackMs);assert(times[10]<=reference.times[10]*limits.p95Ratio+limits.slackMs);
