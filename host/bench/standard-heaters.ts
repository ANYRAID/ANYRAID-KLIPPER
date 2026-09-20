import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {PrinterHeaters} from '../src/thermal/heaters.ts';
import {HeaterRuntime} from '../src/thermal/runtime.ts';
import {PIDControl} from '../src/thermal/control.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
function setup(){
 const group=new PrinterHeaters(()=>{}),runtimes:HeaterRuntime[]=[];
 for(const [name,id] of [['bed','B'],['extruder','T']]){
  const runtime=new HeaterRuntime({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3},new PIDControl({kp:22,ki:1,kd:80,smoothTime:1,maxPower:1}),{configureMaximumDuration(){},schedule(){},turnOff(){}},()=>({system:1,print:1}),{},()=>()=>{});
  runtimes.push(runtime);group.register(name,runtime,id);
 }
 group.start();for(const runtime of runtimes)runtime.sample(1,25);
 let reports=0;const dispatch=new GCodeDispatch({output:message=>{assert.equal(message,'B:25.0 /60.0 T:25.0 /200.0');reports++;},shutdown:reason=>group.shutdown(reason)});group.attach(dispatch,{bed:'bed',extruders:['extruder']});dispatch.setReady(true);
 return {group,dispatch,get reports(){return reports;}};
}
const generic=Array(100).fill('SET_HEATER_TEMPERATURE HEATER=extruder TARGET=200\nSET_HEATER_TEMPERATURE HEATER=bed TARGET=60\nM105').join('\n');
const standard=Array(100).fill('M104 S200\nM140 S60\nM105').join('\n');
const genericTimes:number[]=[],standardTimes:number[]=[];
for(let run=0;run<13;run++){
 for(const [script,times] of (run%2?[[standard,standardTimes],[generic,genericTimes]]:[[generic,genericTimes],[standard,standardTimes]]) as [string,number[]][]){
  const fixture=setup(),begin=performance.now();for(let batch=0;batch<100;batch++)await fixture.dispatch.execute(script);const elapsed=performance.now()-begin;
  assert.equal(fixture.reports,10000);fixture.group.shutdown();if(run>=2)times.push(elapsed);
 }
}
const stats=(a:number[])=>{a.sort((x,y)=>x-y);return {medianMs:a[5],p95Ms:a[10]};};
console.log(JSON.stringify({node:process.version,warmups:2,samples:11,cycles:10000,commandsPerCycle:3,generic:stats(genericTimes),standard:stats(standardTimes),scope:'Existing named-heater commands versus new M104/M140, both through G-code parser, target barrier and M105. Synthetic clock and no-op output; no physical print-speed claim.'},null,2));
