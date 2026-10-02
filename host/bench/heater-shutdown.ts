import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {HeaterRuntime} from '../src/thermal/runtime.ts';
import {PrinterHeaters} from '../src/thermal/heaters.ts';
import {PIDControl} from '../src/thermal/control.ts';
const directory=mkdtempSync(join(tmpdir(),'heater-shutdown-bench-'));
const config={minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3};
const control=()=>new PIDControl({kp:22,ki:1,kd:80,smoothTime:1,maxPower:1});
const before:number[]=[],after:number[]=[],shutdown:number[]=[];
try{
 const source=execFileSync('git',['show','0152005c:host/src/thermal/runtime.ts'],{encoding:'utf8'}).replaceAll("from './",`from '${new URL('../src/thermal/',import.meta.url).href}`);
 const file=join(directory,'runtime.ts');writeFileSync(file,source);const {HeaterRuntime:Before}=await import(pathToFileURL(file).href);
 for(let run=0;run<13;run++){
  for(const [Type,times] of (run%2?[[HeaterRuntime,after],[Before,before]]:[[Before,before],[HeaterRuntime,after]]) as [typeof HeaterRuntime,number[]][]){
   let now=0,tick=()=>{},notified=0;
   const runtime=new Type(config,control(),{configureMaximumDuration(){},schedule(){},turnOff(){}},()=>({system:now,print:now}),{},callback=>{tick=callback;return ()=>{};});
   if(Type===HeaterRuntime)runtime.subscribeShutdown(()=>{notified++;});
   runtime.start();runtime.sample(.1,200);runtime.setTarget(200);const start=performance.now();
   for(let i=2;i<100002;i++){now=i*.1;runtime.sample(now,198);if(i%10===0)tick();}
   const elapsed=performance.now()-start;assert.equal(runtime.status.stopped,false);runtime.shutdown();assert.equal(notified,Type===HeaterRuntime?1:0);
   if(run>=2)times.push(elapsed);
  }
  let stopped=0;const start=performance.now();
  for(let i=0;i<10000;i++){
   const group=new PrinterHeaters(()=>{}),members:HeaterRuntime[]=[];
   for(let j=0;j<3;j++){
    const runtime=new HeaterRuntime(config,control(),{configureMaximumDuration(){},schedule(){},turnOff(){stopped++;}},()=>({system:0,print:0}),{},()=>()=>{});
    group.register(String(j),runtime);members.push(runtime);
   }
   group.start();members[0].shutdown('benchmark fault');assert.equal(group.status.closed,true);for(const runtime of members)assert.equal(runtime.status.stopped,true);
  }
  const elapsed=performance.now()-start;assert.equal(stopped,60000);if(run>=2)shutdown.push(elapsed);
 }
 const stats=(a:number[])=>{a.sort((x,y)=>x-y);return {medianMs:a[5],p95Ms:a[10]};};
 console.log(JSON.stringify({node:process.version,baselineRevision:'0152005c',warmups:2,samples:11,temperatureUpdates:100000,before:stats(before),after:stats(after),threeHeaterGroups:10000,constructionStartupAndFault:stats(shutdown),scope:'Simulated PID, protection ticks and no-op outputs; baseline read from git. No UART, physical shutdown latency or hardware timing.'},null,2));
}finally{rmSync(directory,{recursive:true,force:true});}
