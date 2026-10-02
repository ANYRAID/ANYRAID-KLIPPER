import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {ScheduledCoolingFan,type FanOutput} from '../src/outputs/fan.ts';
import {FanBoundaryTimeline} from '../src/outputs/fan-boundaries.ts';
const dir=mkdtempSync(join(tmpdir(),'fan-tail-'));
try{
 const file=join(dir,'before.ts');writeFileSync(file,execFileSync('git',['show','1689851a:host/src/outputs/fan-boundaries.ts'],{encoding:'utf8'}).replace(/from '([^']+)'/g,(_m,p:string)=>`from '${new URL(p,new URL('../src/outputs/fan-boundaries.ts',import.meta.url)).href}'`));
 const {FanBoundaryTimeline:Before}=await import(pathToFileURL(file).href) as {FanBoundaryTimeline:typeof FanBoundaryTimeline};
 const samples:number[][]=[[],[]];let reference:number[][]|undefined;
 for(let run=0;run<14;run++)for(const variant of run%2?[1,0]:[0,1]){
  const out:number[][]=[],output:FanOutput={configuration:{initialPower:0,defaultPower:0,maximumDuration:0},async reset(){},async stop(){},async setPWM(t,v){out.push([t,v]);}},signal=new AbortController().signal;
  const start=performance.now(),fan=new ScheduledCoolingFan(output,{kickStartTime:.1,minimumScheduleTime:.001});await fan.start(signal);const timeline=new (variant?FanBoundaryTimeline:Before)(fan);
  for(let i=0;i<20000;i++){
   const time=1+i*.5,id=timeline.register(i%2?0:.5);await timeline.deliver([{id,time}],time,signal);
   if(variant)await timeline.settleScheduled(signal);else while(timeline.status.nextTime!==null)await timeline.deliver([],timeline.status.nextTime,signal);
   timeline.retireThrough(timeline.status.horizon);assert.equal(timeline.status.pending,0);
  }
  const elapsed=performance.now()-start;await timeline.stop();if(reference)assert.deepEqual(out,reference);else reference=out;if(run>=3)samples[variant].push(elapsed);
 }
 const stats=samples.map(v=>{v.sort((a,b)=>a-b);return {medianMs:v[5],p95Ms:v[10]};});console.log(JSON.stringify({node:process.version,baseline:'1689851a',samples:11,requests:20000,transitions:reference!.length,variants:['manualSerializedTail','ownedTailSettlement'],stats,exactEventTimesAndPowers:true,scope:'Kick scheduling, ACKed tail settlement and retirement with immediate synthetic transport; excludes physical clock waiting.'}));
 assert(stats[1].medianMs<=stats[0].medianMs*1.3+2,'Tail ownership exceeded baseline regression budget');
}finally{rmSync(dir,{recursive:true,force:true});}
