import assert from 'node:assert/strict';
import {productPrintStatus,productPauseStatus} from '../src/runtime/product-print-status.ts';
import {PrintLayerInfo} from '../src/gcode/print-layer-info.ts';
import type {PrintState,StartPrint} from '../src/operations/print.ts';
const states:PrintState[]=['idle','preparing','printing','pausing','paused','resuming','finishing','completed','cancelling','cancelled','failed','interrupted'];
const request:StartPrint={version:1,requestId:'job',fileId:'published-file',nozzle:200,bed:60},layers=new PrintLayerInfo();layers.reset('job');layers.update({TOTAL_LAYER:'100',CURRENT_LAYER:'20'});
let state:PrintState='idle';const controller={get state(){return state;},get currentRequest(){return state==='idle'?undefined:request;}},filename=(id:string)=>id+'.gcode';
const times:number[][]=[[],[]],iterations=100000;let checksum=0;
for(let run=0;run<14;run++)for(const variant of run%2?[1,0]:[0,1]){
 const start=performance.now();for(let i=0;i<iterations;i++){state=states[i%states.length];const result=variant?{print_stats:productPrintStatus(controller,layers,filename),pause_resume:productPauseStatus(state)}:{print_stats:productPrintStatus(controller,layers)};checksum+=JSON.stringify(result).length;}
 if(run>=3)times[variant].push((performance.now()-start)*1000/iterations);
}
const results=times.map(values=>{values.sort((a,b)=>a-b);return {medianUs:values[5],p95Us:values[10]};});assert(checksum>0);assert(results[1].p95Us-results[0].p95Us<5);
console.log(JSON.stringify({node:process.version,warmups:3,runs:11,iterations,variants:['priorStateAndLayers','publishedFilenameAndPause'],results,maximumAddedP95Us:5,checksum,scope:'Pure current-controller status projection and JSON serialization across 12 states. Excludes actual device operations, transport and physical printing.'}));
