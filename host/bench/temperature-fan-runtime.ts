import assert from 'node:assert/strict';
import {TemperatureFanRuntime} from '../src/thermal/temperature-fan-runtime.ts';
import {TemperatureFanControl} from '../src/thermal/temperature-fan.ts';
import {ScheduledCoolingFan} from '../src/outputs/fan.ts';
import {TemperatureSensorState} from '../src/thermal/temperature-sensor.ts';
const timings:number[]=[];let checksum=0;
for(let run=0;run<12;run++){
 let now=1,callback:(()=>void)|undefined,calls=0,sum=0;
 const output={configuration:{initialPower:0,defaultPower:1,maximumDuration:0},async reset(){},async setPWM(t:number,p:number){calls++;sum+=t+p;},async stop(){}};
 const fan=new ScheduledCoolingFan(output,{shutdownPower:1,kickStartTime:0,minimumScheduleTime:.02});await fan.start(new AbortController().signal);
 const control=new TemperatureFanControl({minimumTemperature:0,maximumTemperature:100,target:40,minimumSpeed:0,maximumSpeed:.5},{kind:'watermark',delta:2},.3);
 let failure:unknown;
 const owner=new TemperatureFanRuntime(fan,control,()=>now,error=>{failure=error;},3,{schedule(cb){callback=cb;return ()=>{callback=undefined;};}});owner.start();
 const sensor=new TemperatureSensorState();sensor.subscribeSample((time,temp)=>owner.sample(time,temp));
 const start=performance.now();
 for(let i=0;i<10000;i++){
  now=1+i*.3;sensor.sample(now,i%2?50:20);now+=.025;const cb=callback;assert(cb);callback=undefined;cb();
  await new Promise(resolve=>setImmediate(resolve));
 }
 const elapsed=performance.now()-start;await owner.stop();assert.equal(failure,undefined);assert.equal(calls,10000);
 if(run)assert.equal(sum,checksum);checksum=sum;if(run>=3)timings.push(elapsed);
}
timings.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,samples:10000,outputWrites:10000,warmups:3,runs:9,medianMs:timings[4],maxMs:timings[8],checksum,scope:'Sensor callback, control, bounded runtime queue, watchdog, scheduled fan, async mock output and setImmediate settlement; no physical MCU or serial transport'},null,2));
