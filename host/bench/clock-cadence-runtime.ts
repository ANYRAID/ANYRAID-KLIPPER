import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {rebuiltFixture} from '../test/helpers/rebuilt-motion.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {RebuiltMotionStreamer} from '../src/runtime/motion-streamer.ts';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
import {SecondarySync} from '../src/timing/secondary-sync.ts';
import {LookAheadQueue,Move,motionLimits} from '../src/motion/lookahead.ts';
// Both variants use the current native/runtime dependencies. Only the cadence
// policy is replaced by the exact prior source, including shared runtime state.
const baseline='ab4d207d2df0da2c298091627256bd611bf4bff7',dir=mkdtempSync(join(tmpdir(),'anyraid-cadence-bench-'));
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]],segments:number[][]=[[],[]];
try{
 const oldPolicy=join(dir,'cadence.ts'),oldRuntime=join(dir,'rebuilt.ts');
 writeFileSync(oldPolicy,execFileSync('git',['show',baseline+':host/src/timing/calibration-cadence.ts'],{encoding:'utf8'}));
 const original=new URL('../src/runtime/rebuilt-motion.ts',import.meta.url),source=execFileSync('git',['show',baseline+':host/src/runtime/rebuilt-motion.ts'],{encoding:'utf8'});
 writeFileSync(oldRuntime,source.replace(/from '([^']+)'/g,(_,spec:string)=>`from '${spec==='../timing/calibration-cadence.ts'?pathToFileURL(oldPolicy).href:new URL(spec,original).href}'`));
 const Previous=(await import(pathToFileURL(oldRuntime).href)).bindRebuiltMotion as typeof bindRebuiltMotion;
 for(let run=0;run<6;run++)for(const mode of run%2?[1,0]:[0,1]){
  const f=await rebuiltFixture(false,false,false,false,true);
  try{
   const clock=new PrintClockTimeline({offset:0,frequency:1e6}),sync=new SecondarySync(f.options.group.session('a').clock.sync,f.options.group.session('m').clock.sync,0,{offset:0,frequency:1e6,syncTime:0});
   const g=await (mode?bindRebuiltMotion:Previous)({...f.options,clockTimelines:[{id:'m',timeline:clock,synchronizer:sync},{id:'a',timeline:new PrintClockTimeline({offset:0,frequency:1e6})}]}),q=new LookAheadQueue(),signal=new AbortController().signal;
   q.add(new Move(motionLimits(100,1000),[50,0,0,2],[58,0,0,2],2));
   const moves=q.flush(),used=process.cpuUsage(),start=performance.now();
   await new RebuiltMotionStreamer(g).append(moves,signal);await g.source.drain([],signal);
   const elapsed=performance.now()-start,usage=process.cpuUsage(used);
   assert.equal(g.motion.bindings[0].history.status.lastPlannedPosition,900n);assert.equal(f.stops,0);assert(clock.status.segments>=(mode?4:2));
   if(run){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000);segments[mode].push(clock.status.segments);}
   await g.coordinator.shutdown();
  }finally{await f.close();}
 }
 const stats=(values:number[])=>{const a=[...values].sort((a,b)=>a-b);return {medianMs:a[2],p95Ms:a[4],samplesMs:values};},timing=wall.map(stats),usage=cpu.map(stats),limits={wallRatio:1.25,cpuRatio:1.5,cpuSlackMs:1};
 console.log(JSON.stringify({node:process.version,baseline,warmups:1,samples:5,variants:['fourSecondPublication','oneSecondPublication'],timing,cpu:usage,segments,limits,scope:'Alternating paired 4-second paced native motion, real serial sessions and firmware-time drain with simulated MCUs. Identical 900-step endpoint. No physical/target-performance claim.'}));
 assert(timing[1].medianMs<timing[0].medianMs*limits.wallRatio);
 assert(usage[1].medianMs<usage[0].medianMs*limits.cpuRatio+limits.cpuSlackMs);
}finally{rmSync(dir,{recursive:true,force:true});}
