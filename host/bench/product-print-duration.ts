import assert from 'node:assert/strict';
import {PrintController} from '../src/operations/print.ts';
import {PrintLayerInfo} from '../src/gcode/print-layer-info.ts';
import {productPrintStatus} from '../src/runtime/product-print-status.ts';
const device={async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){}};
const controller=new PrintController(device,{maxNozzle:300,maxBed:120}),layers=new PrintLayerInfo();
await controller.start({version:1,requestId:'bench',fileId:'file',nozzle:0,bed:0});
const prior={get state(){return controller.state;},get currentRequest(){return controller.currentRequest;}},filename=(id:string)=>id+'.gcode';
const samples:number[][]=[[],[]],iterations=100000;let checksum=0;
try{
 for(let run=0;run<14;run++)for(const variant of run%2?[1,0]:[0,1]){
  const start=performance.now();for(let i=0;i<iterations;i++)checksum+=JSON.stringify(productPrintStatus(variant?controller:prior,layers,filename)).length;
  if(run>=3)samples[variant].push((performance.now()-start)*1000/iterations);
 }
 const results=samples.map(values=>{values.sort((a,b)=>a-b);return {medianUs:values[5],p95Us:values[10]};});
 assert(controller.totalDuration!>0);assert(results[1].p95Us-results[0].p95Us<5);
 console.log(JSON.stringify({node:process.version,warmups:3,runs:11,iterations,variants:['withoutDuration','monotonicDuration'],results,maximumAddedP95Us:5,checksum,scope:'Status snapshot and serialization only; no per-move work, transport or hardware speed claim.'}));
}finally{await controller.retire();}
