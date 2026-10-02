import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {nativeLinearFixture} from '../test/helpers/native-linear-port.ts';
import {NativeLinearGCode} from '../src/runtime/native-linear-gcode.ts';
const rails=[51,0,0].map(endstop=>({endstop,positiveDirection:false,speed:10,retractDistance:0,retractSpeed:10,secondSpeed:5,endstops:['test']}));
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]],directory=mkdtempSync(join(tmpdir(),'idle-scheduler-bench-'));
try{
 const source=execFileSync('git',['show','5c6f9b12:host/src/runtime/native-linear-gcode.ts'],{encoding:'utf8'}),file=join(directory,'gcode.ts');
 writeFileSync(file,source.replace(/from '([^']+)'/g,(_match,spec:string)=>`from '${new URL(spec,new URL('../src/runtime/native-linear-gcode.ts',import.meta.url)).href}'`));
 const Previous=(await import(pathToFileURL(file).href)).NativeLinearGCode as typeof NativeLinearGCode;
 for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
  const t=await nativeLinearFixture(0,()=>false,false,undefined,false,true,true),g=new (mode?NativeLinearGCode:Previous)(t.port,t.kinematics,rails,()=>{});try{
   t.kinematics.markHomed([0]);g.enable();const script=Array.from({length:8},(_,i)=>`G1 X${50+(i+1)/8} F150`).join('\n'),used=process.cpuUsage(),start=performance.now();
   await g.dispatch.execute(script);const elapsed=performance.now()-start,usage=process.cpuUsage(used);
   if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000);}
   assert.equal(t.generation.motion.bindings[0].history.status.lastPlannedPosition,200n);assert.equal(t.f.stops,0);assert.deepEqual(g.coordinates.state.position,[51,0,0,2]);
  }finally{await g.close();await t.close();}
 }
 const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats),limits={wallRatio:1.25,cpuRatio:1.5,cpuSlackMs:2};
 console.log(JSON.stringify({node:process.version,baselineRevision:'5c6f9b12',warmup:3,samples:11,variants:['withoutIdleScheduler','withIdleScheduler'],timing,cpu:usage,limits,scope:'Native G-code paced printing with two emulated MCUs and active stream calibration; scheduler must skip busy dispatch; no physical printing.'}));
 assert(timing[1].medianMs<timing[0].medianMs*limits.wallRatio);assert(usage[1].medianMs<usage[0].medianMs*limits.cpuRatio+limits.cpuSlackMs);
}finally{rmSync(directory,{recursive:true,force:true});}
