import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseAccelerometerLog} from '../src/calibration/accelerometer-log.ts';
import {accelerometerPlots} from '../src/diagnostics/graph-accelerometer.ts';
import {writeStatsPanels} from '../src/diagnostics/graphstats-file.ts';
import {graphAccelerationFixture} from '../contracts/accelerometer-fixtures.ts';
import {accelerometerReference,accelerometerManifest,verifyAccelerationInput,compareAccelerationPlots,timing} from '../test/helpers/accelerometer-reference.ts';
const dir=await mkdtemp(join(tmpdir(),'accel-graph-bench-')),text=graphAccelerationFixture(),reports=[];
try{for(const raw of [true,false]){
 const reference=accelerometerReference.graphs[raw?'raw':'frequency'];verifyAccelerationInput(text,reference.inputSha256);const log=parseAccelerometerLog(text,'raw.csv'),samples:number[]=[],exports:number[]=[];let maxError=0;
 for(let i=0;i<16;i++){const start=performance.now(),panels=accelerometerPlots([log],{raw});if(i>=5)samples.push(performance.now()-start);maxError=Math.max(maxError,compareAccelerationPlots(panels,reference));const at=performance.now();await writeStatsPanels(panels,join(dir,'output.png'),new AbortController().signal);if(i>=5)exports.push(performance.now()-at);}
 const node=timing(samples),historicalPython=timing(reference.samples.slice(5)),pngExport=timing(exports),historicalNodeExport=accelerometerManifest.reports['graph-accelerometer'].reports.find(r=>r.raw===raw)!.pngExport;
 assert(node.medianMs<=historicalPython.medianMs*1.25+2);assert(node.p95Ms<=historicalPython.p95Ms*1.5+2);assert(pngExport.medianMs<=historicalNodeExport.medianMs*1.25+10);assert(pngExport.p95Ms<=historicalNodeExport.p95Ms*1.5+20);
 reports.push({raw,node,historicalPython,pngExport,maxError});
}console.log(JSON.stringify({node:process.version,samples:8192,warmups:5,runs:11,reports,scope:'Original captured raw/frequency curves; historical Python timing, not a fresh run. PNG export measured separately; no motion timing.'},null,2));}finally{await rm(dir,{recursive:true,force:true});}
