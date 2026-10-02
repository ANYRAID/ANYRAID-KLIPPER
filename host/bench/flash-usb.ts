import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {flashUsb,type UsbFlashOptions} from '../src/diagnostics/flash-usb.ts';
import {flashRecorder,flashReference,flashContract} from './flash-usb-reference.ts';

const cases:(UsbFlashOptions&{katapult?:boolean})[]=[
 {mcu:'sam4',device:'/dev/ttyMock',image:'/tmp/image.bin'},
 {mcu:'stm32f407',device:'/dev/ttyMock',image:'/tmp/image.bin',start:0x8000000},
 {mcu:'rp2350',device:'/dev/ttyMock',image:'/tmp/image.bin'},
 {mcu:'stm32f103',device:'/dev/ttyMock',image:'/tmp/image.bin',start:0x8000800,katapult:true},
];
const warmup=100,runs=1001,reference=flashReference(cases);
function stats(samples:number[]){const sorted=[...samples].sort((a,b)=>a-b);return {medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.ceil(sorted.length*0.95)-1]};}
const results=[];
for(const [index,options] of cases.entries()){
 const samples:number[]=[],signal=new AbortController().signal;
 for(let i=0;i<warmup+runs;i++){
  const recorder=flashRecorder(options.katapult),at=performance.now();
  await flashUsb(options,recorder.io,signal);
  const elapsed=performance.now()-at;
  assert.deepEqual(recorder.events,reference.results[index].events);
  if(i>=warmup)samples.push(elapsed);
 }
 results.push({mcu:options.mcu,katapult:options.katapult??false,actions:reference.results[index].events.length,node:stats(samples),historicalPython:flashContract.historicalMeasurements.routing.results[index].python});
}
console.log(JSON.stringify({node:process.version,historicalReference:flashContract.provenance,warmup,runs,scope:'Injected action recording only; no subprocess, USB, re-enumeration waits or firmware writes. Node includes asynchronous dispatch and validation; Python includes suppressed progress formatting. Not print-speed evidence.',results},null,2));
