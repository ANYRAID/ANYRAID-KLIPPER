import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {rebuiltFixture} from '../test/helpers/rebuilt-motion.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {LinearHomingSeek} from '../src/homing/linear-seek.ts';
import {LinearKinematics} from '../src/kinematics/linear.ts';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
import {SecondarySync} from '../src/timing/secondary-sync.ts';
import {inputShaper} from '../src/motion/shaper.ts';
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]],directory=mkdtempSync(join(tmpdir(),'homing-clock-bench-'));
try{
 const source=execFileSync('git',['show','ab80bf1b:host/src/homing/linear-seek.ts'],{encoding:'utf8'}),file=join(directory,'seek.ts');
 writeFileSync(file,source.replace(/from '([^']+)'/g,(_match,spec:string)=>`from '${new URL(spec,new URL('../src/homing/linear-seek.ts',import.meta.url)).href}'`));
 const Previous=(await import(pathToFileURL(file).href)).LinearHomingSeek as typeof LinearHomingSeek;
 for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
  const f=await rebuiltFixture(false,true,false,false,true);let result:Awaited<ReturnType<LinearHomingSeek['run']>>|undefined;
  try{
   const group=f.options.group,clock=new PrintClockTimeline({offset:0,frequency:1e6}),sync=new SecondarySync(group.session('a').clock.sync,group.session('m').clock.sync,0,{offset:0,frequency:1e6,syncTime:0});
   const generation=await bindRebuiltMotion({...f.options,clockTimelines:[{id:'m',timeline:clock,synchronizer:sync},{id:'a',timeline:new PrintClockTimeline({offset:0,frequency:1e6})}]}),kinematics=new LinearKinematics({kind:'cartesian',ranges:[[0,200],[0,200],[0,200]],maxVelocity:100,maxAccel:1000,maxZVelocity:5,maxZAccel:100});
   generation.motion.bindings[0].stepper.configureShapers({x:inputShaper('mzv',40,.1)});
   f.fw.setTriggerReason(3,8);f.fw.setStepperPosition(3,200);
   const options={generation,kinematics,emitters:f.emitters,kinematicIds:['x','y','z'] as const,groups:[{members:[{physicalMember:0,trigger:f.options.members[0].trigger,emitters:f.emitters.map(e=>e.id)}],primary:0,endstop:f.endstop,expireTimeout:.25}]};
   const used=process.cpuUsage(),start=performance.now();result=await new (mode?LinearHomingSeek:Previous)(options).run([51,0,0,2],2,0,new AbortController().signal);
   const elapsed=performance.now()-start,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000);}
   assert.equal(clock.status.segments,mode?2:1);assert.equal(result.offsets[0].trigger,200n);assert.deepEqual(result.position,[51,0,0,2]);assert.equal(f.stops,0);
  }finally{result?.motion.dispose();await f.close();}
 }
 const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats),limits={wallRatio:1.25,cpuRatio:1.5,cpuSlackMs:2};
 console.log(JSON.stringify({node:process.version,baselineRevision:'ab80bf1b',warmup:3,samples:11,variants:['fixedHomingMapping','periodicHomingCalibration'],timing,cpu:usage,limits,scope:'Shaped native seek, no-hit readback and generation rebind on two emulated MCUs. Baseline seek owner uses current shared components. No physical printing.'}));
 assert(timing[1].medianMs<timing[0].medianMs*limits.wallRatio);assert(usage[1].medianMs<usage[0].medianMs*limits.cpuRatio+limits.cpuSlackMs);
}finally{rmSync(directory,{recursive:true,force:true});}
