import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {ADCTemperature} from '../src/thermal/adc.ts';
import {Thermistor} from '../src/thermal/thermistor.ts';
const directory=mkdtempSync(join(tmpdir(),'adc-baseline-'));
try{
 const file=join(directory,'adc.ts');
 writeFileSync(file,execFileSync('git',['show','3de0fe62:host/src/thermal/adc.ts']));
 const {ADCTemperature:Baseline}=await import(pathToFileURL(file).href);
 const converter=new Thermistor(4700,0,{point:[25,100000],beta:3950});
 const samples=Array.from({length:1024},(_,i)=>[[i*.3,converter.adc(25+i*.2)]] as const);
 const baseline:number[]=[],current:number[]=[];const count=1000000;
 for(let run=0;run<13;run++){
  for(const [Type,times] of (run%2?[[ADCTemperature,current],[Baseline,baseline]]:[[Baseline,baseline],[ADCTemperature,current]])){
   let delivered=0,sum=0;
   const adc=new Type(converter,0,300,(_time:number,temp:number)=>{delivered++;sum+=temp;},()=>assert.fail('unexpected fault'));
   const start=performance.now();for(let i=0;i<count;i++)adc.receive(samples[i%1024]);const elapsed=performance.now()-start;
   assert.equal(delivered,count);assert.ok(Number.isFinite(sum)&&sum>25000000);
   if(run>=2)times.push(elapsed);
  }
 }
 const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[5],p95Ms:values[10]};};
 console.log(JSON.stringify({node:process.version,baselineRevision:'3de0fe62',warmups:2,samples:11,updates:count,baseline:stats(baseline),current:stats(current),scope:'Alternating in-process ADC conversion and callback, preallocated reports, no hardware or status polling.'},null,2));
}finally{rmSync(directory,{recursive:true,force:true});}
