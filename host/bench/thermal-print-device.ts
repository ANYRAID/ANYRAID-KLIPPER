import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {PrintController,type PrintDevice} from '../src/operations/print.ts';
import {ThermalPrintDevice} from '../src/operations/thermal-print-device.ts';
import {AsyncPrinterHeaters} from '../src/thermal/async-heaters.ts';
import {AsyncHeaterRuntime} from '../src/thermal/async-runtime.ts';
import {BangBangControl} from '../src/thermal/control.ts';
const times:number[][]=[[],[],[],[]],count=1000;
for(let run=0;run<13;run++)for(const variant of run%2?[3,2,1,0]:[0,1,2,3]){
 const begin=performance.now();
 for(let i=0;i<count;i++){
  const group=new AsyncPrinterHeaters(()=>{}),members:AsyncHeaterRuntime[]=[];
  for(const name of ['extruder','bed']){const runtime=new AsyncHeaterRuntime({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3},new BangBangControl(1),{configuration:{cycleTime:.1,maximumDuration:3,initialPower:0,defaultPower:0},reset:async()=>{},setPWM:async()=>{},stop:async()=>{}},()=>({system:1,print:1}),{},()=>()=>{});group.register(name,runtime);members.push(runtime);}
  await group.start();for(const runtime of members)runtime.sample(1,220);
  let stops=0,finished=0;const underlying:PrintDevice={prepare:async()=>{},start:async()=>{},pause:async()=>{},resume:async()=>{},finish:async()=>{finished++;},stop:async()=>{stops++;}};
  const device=variant%2?new ThermalPrintDevice(underlying,group,{nozzle:'extruder',bed:'bed'}):underlying;
  const controller=new PrintController(device,{maxNozzle:300,maxBed:130});await controller.start({version:1,requestId:'job',fileId:'file',nozzle:200,bed:60});
  if(variant<2){await controller.complete('job');assert.equal(controller.state,'completed');assert.equal(finished,1);}else{await controller.cancel();assert.equal(controller.state,'cancelled');assert.equal(stops,1);}
  // Includes disposal of the common fixture; normal terminal job stays recorded.
  await group.shutdown();if(variant%2)await controller.fault(new Error('fixture cleanup'));
 }
 const elapsed=performance.now()-begin;if(run>=2)times[variant].push(elapsed);
}
const stats=(a:number[])=>{a.sort((x,y)=>x-y);return {medianMs:a[5],p95Ms:a[10]};};
console.log(JSON.stringify({node:process.version,warmups:2,runs:11,jobs:count,variants:['baseComplete','thermalComplete','baseCancel','thermalCancel'],times:times.map(stats),scope:'Controller and two heaters constructed per job, mock motion and immediate ACK; no heating time, UART or print throughput'},null,2));
