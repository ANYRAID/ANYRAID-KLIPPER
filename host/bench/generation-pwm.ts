import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {GenerationPWMOutput} from '../src/outputs/generation-pwm.ts';
import {PWMOutput,compilePWM} from '../src/outputs/pwm.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
const directory=mkdtempSync(join(tmpdir(),'generation-pwm-bench-'));
try{
 const file=join(directory,'pwm.ts');writeFileSync(file,execFileSync('git',['show','a593d551:host/src/outputs/pwm.ts'],{encoding:'utf8'}).replaceAll("from '../",`from '${new URL('../src/',import.meta.url).href}`));
 const {PWMOutput:Before}=await import(pathToFileURL(file).href);
 const dictionary=new MessageDictionary();dictionary.identify(Buffer.from(JSON.stringify({commands:{'config_pwm_out oid=%c pin=%u cycle_ticks=%u value=%hu default_value=%hu max_duration=%u':24,'queue_pwm_out oid=%c clock=%u value=%hu':25,'queue_pwm_out_generation oid=%c clock=%u value=%hu generation=%u':30,'reset_pwm_out_generation oid=%c generation=%u':31},responses:{},config:{CLOCK_FREQ:1000000,PWM_MAX:255}})),false);
 const chip={},clock=(t:number)=>BigInt(Math.trunc(t*1e6)),print=(c:bigint)=>Number(c)/1e6;
 const plan=compilePWM(chip,dictionary,{oid:3,pin:{chip,chipName:'mcu',pin:'PA0',invert:0,pullup:0},hardware:true,currentPrintTime:1},clock);
 const before:number[]=[],legacy:number[]=[],generation:number[]=[],resets:number[]=[];const signal=new AbortController().signal;
 for(let run=0;run<13;run++){
  for(const mode of run%2?[2,1,0]:[0,1,2]){
   let sent=0;const queue={async send(){sent++;},async stop(){}},control={async send(){},async stop(){}};
   const output=mode===2?new GenerationPWMOutput(plan,dictionary,queue,control,clock,print):new (mode===0?Before:PWMOutput)(plan,dictionary,queue,clock,print);
   if(mode===2)await output.reset(signal);
   const start=performance.now();for(let i=0;i<100000;i++)await output.setPWM(2+i*.0001,.5,signal);const elapsed=performance.now()-start;
   assert.equal(sent,100000);if(run>=2)[before,legacy,generation][mode].push(elapsed);
   if(mode===2){const begin=performance.now();for(let i=0;i<10000;i++)await output.reset(signal);if(run>=2)resets.push(performance.now()-begin);await output.stop();}
  }
 }
 const stats=(a:number[])=>{a.sort((x,y)=>x-y);return {medianMs:a[5],p95Ms:a[10]};};
 console.log(JSON.stringify({node:process.version,baselineRevision:'a593d551',warmups:2,samples:11,writes:100000,before:stats(before),currentLegacy:stats(legacy),generation:stats(generation),resets:10000,resetResult:stats(resets),scope:'Encoding and resolved transport acknowledgements; no serial IO or physical output. Reset benchmark has no stale host backlog.'},null,2));
}finally{rmSync(directory,{recursive:true,force:true});}
