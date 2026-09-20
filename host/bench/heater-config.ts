import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {AnalogSensorRegistry} from '../src/thermal/sensor-config.ts';
import {createConfiguredHeater} from '../src/thermal/heater-config.ts';
const reader=new ConfigurationReader(new ConfigurationSource('/bench.cfg',{extruder:{sensor_type:'Generic 3950',min_temp:'0',max_temp:'300',control:'pid',pid_kp:'22',pid_ki:'1',pid_kd:'80'}},[]),null),registry=new AnalogSensorRegistry(reader);
const output={configureCycleTime(){},configureMaximumDuration(){},schedule(){},turnOff(){}};
const construction:number[]=[],sampling:number[]=[];
for(let run=0;run<13;run++){
 let now=1;let tick=()=>{};const clock=()=>({system:now,print:now}),timer=(cb:()=>void)=>{tick=cb;return ()=>{};};
 let begin=performance.now();
 for(let i=0;i<10000;i++)createConfiguredHeater(reader,'extruder',output,clock,timer,registry);
 const created=performance.now()-begin;
 const heater=createConfiguredHeater(reader,'extruder',output,clock,timer,registry);heater.runtime.start();const adc=heater.converter.adc(25);
 heater.adc.receive([[now,adc]]);heater.runtime.setTarget(25);begin=performance.now();
 for(let i=1;i<=100000;i++){now=1+i*.001;heater.adc.receive([[now,adc]]);if(i%1000===0)tick();}
 const sampled=performance.now()-begin;assert.equal(heater.runtime.status.stopped,false);heater.runtime.shutdown('benchmark finished');
 if(run>=2){construction.push(created);sampling.push(sampled);}
}
const stats=(a:number[])=>{a.sort((x,y)=>x-y);return {medianMs:a[5],p95Ms:a[10]};};
console.log(JSON.stringify({node:process.version,warmups:2,samples:11,constructors:10000,adcUpdates:100000,construction:stats(construction),sampling:stats(sampling),scope:'Parsed configuration and reused sensor registry; synthetic ADC, PID, protection timers and no-op output. Not hardware timing.'},null,2));
