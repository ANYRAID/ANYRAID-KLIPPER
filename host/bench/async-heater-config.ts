import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {AnalogSensorRegistry} from '../src/thermal/sensor-config.ts';
import {createConfiguredHeater,createConfiguredAsyncHeater} from '../src/thermal/heater-config.ts';
const reader=new ConfigurationReader(new ConfigurationSource('/bench.cfg',{extruder:{sensor_type:'Generic 3950',min_temp:'0',max_temp:'300',control:'pid',pid_kp:'22',pid_ki:'1',pid_kd:'80'}},[]),null),registry=new AnalogSensorRegistry(reader);
const directory=mkdtempSync(join(tmpdir(),'async-heater-config-'));
try{
 const source=execFileSync('git',['show','b51fe2ec:host/src/thermal/heater-config.ts'],{encoding:'utf8'}).replace(/from '([^']+)'/g,(_match,path:string)=>`from '${new URL(path,new URL('../src/thermal/heater-config.ts',import.meta.url)).href}'`);
 const file=join(directory,'heater-config.ts');writeFileSync(file,source);const {createConfiguredHeater:before}=await import(pathToFileURL(file).href) as {createConfiguredHeater:typeof createConfiguredHeater};
 const construction:number[][]=[[],[],[]],sampling:number[][]=[[],[],[]];let expected:number[][]|undefined;
 for(let run=0;run<13;run++)for(const kind of run%2?[2,1,0]:[0,1,2]){
  let now=1,tick=()=>{};const writes:number[][]=[],clock=()=>({system:now,print:now}),timer=(callback:()=>void)=>{tick=callback;return ()=>{};};
  const output={configureCycleTime(){},configureMaximumDuration(){},schedule(t:number,p:number){writes.push([t,p]);},turnOff(){}};
  const create=()=>kind===2?createConfiguredAsyncHeater(reader,'extruder',r=>({configuration:{cycleTime:r.cycleTime,maximumDuration:r.maximumDuration,defaultPower:r.shutdown,initialPower:r.start},reset:async()=>{},setPWM:async(t,p)=>{writes.push([t,p]);},stop:async()=>{}}),clock,timer,registry):(kind===0?before:createConfiguredHeater)(reader,'extruder',output,clock,timer,registry);
  let begin=performance.now();for(let i=0;i<10000;i++)create();const created=performance.now()-begin;
  const heater=create(),adc=heater.converter.adc(198);await heater.runtime.start();heater.adc.receive([[now,adc]]);await heater.runtime.setTarget(200);begin=performance.now();
  for(let i=1;i<=100000;i++){now=1+i*.001;heater.adc.receive([[now,adc]]);if(i%1000===0)tick();if(i%16===0){await Promise.resolve();await Promise.resolve();}}
  const sampled=performance.now()-begin;assert.equal(heater.runtime.status.stopped,false);await heater.runtime.shutdown();
  if(!expected)expected=writes;else assert.deepEqual(writes,expected);
  if(run>=2){construction[kind].push(created);sampling[kind].push(sampled);}
 }
 const stats=(a:number[])=>{a.sort((x,y)=>x-y);return {medianMs:a[5],p95Ms:a[10]};};
 console.log(JSON.stringify({node:process.version,baseline:'b51fe2ec',warmups:2,runs:11,constructors:10000,adcUpdates:100000,pwmWrites:expected!.length,outputExact:true,variants:['baselineSync','currentSync','currentAsync'],construction:construction.map(stats),sampling:sampling.map(stats),scope:'Parsed configuration, shared registry, synthetic ADC and immediate ACK; no physical timing'},null,2));
}finally{rmSync(directory,{recursive:true,force:true});}
