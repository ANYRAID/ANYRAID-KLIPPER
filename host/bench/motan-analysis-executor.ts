import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {MotanAnalysisExecutor} from '../src/motan/analysis-executor.ts';
import {MotanAnalyzer,type MotanAnalysis} from '../src/motan/analyzer.ts';
import {MotanLogManager} from '../src/motan/log-manager.ts';
import {managerFixture} from '../test/helpers/motan-manager-fixture.ts';

const stats=(ms:number[])=>{ms.sort((a,b)=>a-b);return {median:ms[3],p95:ms[6]};};
async function measure(run:()=>Promise<MotanAnalysis>){
 let previous=performance.now(),maxGap=0,ticks=0;
 const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-previous);previous=now;ticks++;},1);
 const start=performance.now();
 try{const result=await run(),end=performance.now();maxGap=Math.max(maxGap,end-previous);
  return {result,ms:end-start,maxGap,ticks};
 }finally{clearInterval(timer);}
}
const dir=await mkdtemp(join(tmpdir(),'motan-worker-bench-')),prefix=join(dir,'log');
try{
 await managerFixture(prefix);
 for(const heavy of [false,true]){
  const datasets=heavy?Array.from({length:40},(_,i)=>`sos(accelerometer(a,x),filtfilt,bandpass,64,${20+i*.1},${100+i*.1})`):['sos(accelerometer(a,x),filtfilt,bandpass,8,20,100)'];
  const request={prefix,datasets,segmentTime:.001,duration:1},executor=new MotanAnalysisExecutor();
  const inline=async()=>{const manager=await MotanLogManager.open(prefix);try{
   const analyzer=new MotanAnalyzer(manager,.001);for(const name of datasets)analyzer.addDataset(name);return await analyzer.generate(1);
  }finally{await manager.close();}};
  try{
   const reference=await inline();
   for(const mode of ['inline','worker'] as const){
    const times:number[]=[],gaps:number[]=[];let ticks=0;
    for(let i=0;i<9;i++){
     const sample=await measure(mode==='inline'?inline:()=>executor.analyze(request));
     assert.deepEqual(sample.result,reference);
     if(i>=2){times.push(sample.ms);gaps.push(sample.maxGap);ticks+=sample.ticks;}
    }
    console.log(JSON.stringify({node:process.version,mode,heavy,datasets:datasets.length,
     samples:reference.times.length,elapsedMs:stats(times),maxObservedMainTimerGapMs:Math.max(...gaps),timerTicks:ticks,exact:true}));
   }
  }finally{await executor.close();}
 }
}finally{await rm(dir,{recursive:true,force:true});}
