import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {GenerationPWMOutput} from '../src/outputs/generation-pwm.ts';
import {compilePWM} from '../src/outputs/pwm.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
const dir=mkdtempSync(join(tmpdir(),'pwm-stop-fence-'));
try{
 const file=join(dir,'before.ts');writeFileSync(file,execFileSync('git',['show','e00ba26a:host/src/outputs/generation-pwm.ts'],{encoding:'utf8'}).replace(/from '([^']+)'/g,(_m,p:string)=>`from '${new URL(p,new URL('../src/outputs/generation-pwm.ts',import.meta.url)).href}'`));
 const {GenerationPWMOutput:Before}=await import(pathToFileURL(file).href) as {GenerationPWMOutput:typeof GenerationPWMOutput};
 const dictionary=new MessageDictionary();dictionary.identify(Buffer.from(JSON.stringify({commands:{'config_pwm_out oid=%c pin=%u cycle_ticks=%u value=%hu default_value=%hu max_duration=%u':24,'queue_pwm_out oid=%c clock=%u value=%hu':25,'queue_pwm_out_generation oid=%c clock=%u value=%hu generation=%u':30,'reset_pwm_out_generation oid=%c generation=%u':31},responses:{},config:{CLOCK_FREQ:1000000,PWM_MAX:255}})),false);
 const chip={},clock=(t:number)=>BigInt(Math.trunc(t*1e6)),print=(c:bigint)=>Number(c)/1e6,signal=new AbortController().signal;
 const plan=compilePWM(chip,dictionary,{oid:3,pin:{chip,chipName:'mcu',pin:'PA0',invert:0,pullup:0},hardware:true,currentPrintTime:1},clock);
 const writes:number[][]=[[],[]],resets:number[][]=[[],[]];let reference:unknown[]|undefined;
 for(let run=0;run<14;run++)for(const variant of run%2?[1,0]:[0,1]){
  const packets:unknown[]=[],queue={async send(data:Uint8Array,min:bigint,req:bigint){packets.push([Buffer.from(data).toString('hex'),min,req]);},async stop(){}},control={async send(){},async stop(){}};
  const output=new (variant?GenerationPWMOutput:Before)(plan,dictionary,queue,control,clock,print);await output.reset(signal);
  const start=performance.now();for(let i=0;i<20000;i++)await output.setPWM(2+i*.001,(i%4)/3,signal);const elapsed=performance.now()-start;
  const resetStart=performance.now();for(let i=0;i<1000;i++)await output.reset(signal);const resetElapsed=performance.now()-resetStart;await output.stop();
  assert.equal(packets.length,20000);if(reference)assert.deepEqual(packets,reference);else reference=packets;if(run>=3){writes[variant].push(elapsed);resets[variant].push(resetElapsed);}
 }
 const stats=(groups:number[][])=>groups.map(v=>{v.sort((a,b)=>a-b);return {medianMs:v[5],p95Ms:v[10]};}),writeStats=stats(writes),resetStats=stats(resets);
 console.log(JSON.stringify({node:process.version,baseline:'e00ba26a',samples:11,variants:['previous','settledStop'],writes:20000,writeStats,resets:1000,resetStats,exactPayloadsAndClocks:true,scope:'PWM encoding, immediate transport acknowledgements and reset tracking; excludes physical serial deadlines.'}));
 assert(writeStats[1].medianMs<=writeStats[0].medianMs*1.3+2,'PWM hot write path regression');assert(resetStats[1].medianMs<=resetStats[0].medianMs*1.5+2,'PWM reset tracking regression');
}finally{rmSync(dir,{recursive:true,force:true});}
