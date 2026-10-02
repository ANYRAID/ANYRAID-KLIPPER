import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {ScheduledCoolingFan,type FanOutput} from '../src/outputs/fan.ts';
import {FanBoundaryTimeline} from '../src/outputs/fan-boundaries.ts';
const count=20000,samples:number[][]=[[],[]];let reference:number[][]|undefined;
for(let run=0;run<14;run++)for(const indexed of run%2?[true,false]:[false,true]){
 const out:number[][]=[],output:FanOutput={configuration:{initialPower:0,defaultPower:0,maximumDuration:0},async reset(){},async stop(){},async setPWM(t,v){out.push([t,v]);}},signal=new AbortController().signal;
 const start=performance.now(),fan=new ScheduledCoolingFan(output,{kickStartTime:0,minimumScheduleTime:.001});await fan.start(signal);const timeline=indexed?new FanBoundaryTimeline(fan):undefined;
 for(let offset=0;offset<count;offset+=512){
  const end=Math.min(count,offset+512),boundaries:{id:number;time:number}[]=[];
  for(let i=offset;i<end;i++){const time=i*.005,value=(i%4)/3;if(timeline)boundaries.push({id:timeline.register(value),time});else fan.enqueue(time,value);}
  const horizon=(end-1)*.005;if(timeline){await timeline.deliver(boundaries,horizon,signal);timeline.retireThrough(horizon);assert.equal(timeline.status.pending,0);}else await fan.flush(horizon,signal);
 }
 const elapsed=performance.now()-start;assert.equal(fan.status.pending,0);if(reference)assert.deepEqual(out,reference);else reference=out;await fan.stop();if(run>=3)samples[indexed?1:0].push(elapsed);
}
const stats=samples.map(v=>{v.sort((a,b)=>a-b);return {medianMs:v[5],p95Ms:v[10]};});
console.log(JSON.stringify({node:process.version,requests:count,transitions:reference!.length,samples:11,variants:['fan','boundedTimeline'],stats,extraMicrosecondsPerRequest:(stats[1].medianMs-stats[0].medianMs)*1000/count,scope:'Registration, endpoint resolution, immediate synthetic ACKs and clock retirement; no physical MCU or scheduling jitter proof.'}));
assert(stats[1].medianMs<=stats[0].medianMs+count*.001+2,'Timeline overhead exceeded 1 microsecond per request plus 2 ms');
