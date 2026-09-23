import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {nativeLinearFixture} from '../test/helpers/native-linear-port.ts';
import {NativeLinearGCode} from '../src/runtime/native-linear-gcode.ts';
const rails=[51,0,0].map(endstop=>({endstop,positiveDirection:false,speed:10,retractDistance:0,retractSpeed:10,secondSpeed:5,endstops:['test']}));
const scripts=[false,true].map(fan=>Array.from({length:1000},(_,i)=>`G1 X${(50+(i+1)/1000).toFixed(6)} F600${fan&&(i+1)%100===0?`\nM106 S${((i+1)/100)%2?64:128}`:''}`).join('\n'));
const times:number[][]=[[],[]],cpu:number[][]=[[],[]];let reference:Record<string,[bigint,bigint][]>|undefined,maxTickError=0n,steps=0;
for(let run=0;run<14;run++)for(const fan of run%2?[1,0]:[0,1]){
 const t=await nativeLinearFixture(0,()=>false,true,fan?{kickStartTime:0,minimumScheduleTime:.001}:undefined),g=new NativeLinearGCode(t.port,t.kinematics,rails,()=>{});
 try{
  t.kinematics.markHomed([0]);g.enable();const source=t.generation.source,ticks:Record<string,[bigint,bigint][]>=Object.fromEntries(t.generation.motion.bindings.map(b=>[b.id,[]]));let start=0;const startAt=source.startAt.bind(source);source.startAt=time=>{start=time;startAt(time);};
  for(const b of t.generation.motion.bindings){const flush=b.stepper.flushThrough.bind(b.stepper);b.stepper.flushThrough=time=>{const out=flush(time);for(let i=0;i<out.history.length;i+=6){const [first,,position,count,interval,add]=out.history.slice(i,i+6),n=count<0n?-count:count;for(let j=0n;j<n;j++)ticks[b.id].push([first+j*interval+add*j*(j+1n)/2n-b.stepper.clockAt(start),position+(count<0n?-1n:1n)*(j+1n)]);}return out;};}
  const used=process.cpuUsage(),begin=performance.now();await g.dispatch.execute(scripts[fan]);const elapsed=performance.now()-begin,usage=process.cpuUsage(used);
  assert.deepEqual(t.port.position(),[51,0,0,2]);assert.equal(t.generation.motion.bindings[0].history.status.lastPlannedPosition,200n);assert.equal(t.f.stops,0);
  const outputs=t.f.fw.outputs.filter(m=>m.name==='queue_pwm_out_generation');assert.equal(outputs.length,fan?10:0);if(fan){assert.deepEqual(outputs.map(m=>m.parameters.value),Array.from({length:10},(_,i)=>i%2?128:64));assert.equal(t.timeline!.status.pending,0);}
  for(const rows of Object.values(ticks))rows.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  if(!reference){reference=ticks;steps=Object.values(ticks).reduce((n,t)=>n+t.length,0);}else for(const id of Object.keys(reference)){assert.equal(ticks[id].length,reference[id].length);for(let i=0;i<ticks[id].length;i++){assert.equal(ticks[id][i][1],reference[id][i][1]);const d:bigint=ticks[id][i][0]-reference[id][i][0],error:bigint=d<0n?-d:d;assert(error<=1n);if(error>maxTickError)maxTickError=error;}}
  if(run>=3){times[fan].push(elapsed);cpu[fan].push((usage.user+usage.system)/1000);}
 }finally{await g.close();await t.close();}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};const timing=times.map(stats),usage=cpu.map(stats);
console.log(JSON.stringify({node:process.version,samples:11,moves:1000,fanCommands:10,variants:['nativeGCode','nativeGCodeAndFan'],timing,cpu:usage,stepsCompared:steps,maxTickError:String(maxTickError),scope:'Real G-code parsing/admission, native MZV, serial motion/PWM emulator and drain; excludes startup and hardware acceptance.'}));
assert(timing[1].medianMs<=timing[0].medianMs*1.1+10,'Fan commands slowed native G-code wall time');assert(usage[1].medianMs<=usage[0].medianMs*1.5+3,'Fan commands slowed native G-code CPU');
