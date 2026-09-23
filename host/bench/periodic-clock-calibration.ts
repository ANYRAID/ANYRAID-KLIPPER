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
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]];
const directory=mkdtempSync(join(tmpdir(),'periodic-clock-bench-'));
try{
 const source=execFileSync('git',['show','d7f50b1c:host/src/runtime/motion-streamer.ts'],{encoding:'utf8'}),file=join(directory,'streamer.ts');
 writeFileSync(file,source.replace(/from '([^']+)'/g,(_match,spec:string)=>`from '${new URL(spec,new URL('../src/runtime/motion-streamer.ts',import.meta.url)).href}'`));
 const Previous=(await import(pathToFileURL(file).href)).RebuiltMotionStreamer as typeof RebuiltMotionStreamer;
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const f=await rebuiltFixture(false,false,false,false,true);try{
  const clock=new PrintClockTimeline({offset:0,frequency:1e6}),sync=new SecondarySync(f.options.group.session('a').clock.sync,f.options.group.session('m').clock.sync,0,{offset:0,frequency:1e6,syncTime:0});
  const g=await bindRebuiltMotion({...f.options,clockTimelines:[{id:'m',timeline:clock,synchronizer:sync},{id:'a',timeline:new PrintClockTimeline({offset:0,frequency:1e6})}]}),stream=new (mode?RebuiltMotionStreamer:Previous)(g),q=new LookAheadQueue(),signal=new AbortController().signal;
  for(let i=0;i<8;i++)q.add(new Move(motionLimits(100,1000),[50+i,0,0,2],[51+i,0,0,2],20));
  const moves=q.flush(),used=process.cpuUsage(),start=performance.now();await stream.append(moves,signal);await g.source.drain([],signal);
  const elapsed=performance.now()-start,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000);}
  assert.equal(g.motion.bindings[0].history.status.lastPlannedPosition,900n);assert.equal(clock.status.segments,mode?2:1);assert.equal(f.stops,0);await g.coordinator.shutdown();
 }finally{await f.close();}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats),limits={wallRatio:1.25,cpuRatio:1.5,cpuSlackMs:1};
console.log(JSON.stringify({node:process.version,baselineRevision:'d7f50b1c',warmup:3,samples:11,variants:['manualCalibrationStream','periodicCalibrationStream'],timing,cpu:usage,limits,scope:'Paced native motion, automatic secondary calibration, retention, ACK and firmware-time drain with emulated firmware; no physical printing.'}));
assert(timing[1].medianMs<timing[0].medianMs*limits.wallRatio);assert(usage[1].medianMs<usage[0].medianMs*limits.cpuRatio+limits.cpuSlackMs);
}finally{rmSync(directory,{recursive:true,force:true});}
