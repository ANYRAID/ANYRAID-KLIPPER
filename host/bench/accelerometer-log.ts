import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseAccelerometerLog,accelerometerDatasets} from '../src/calibration/accelerometer-log.ts';
import {calibrationLogFixtures} from '../contracts/calibration-fixtures.ts';
import {calibrationReference,verifyCalibrationInput,compareCalibrationDatasets} from '../test/helpers/calibration-reference.ts';
const dir=mkdtempSync(join(tmpdir(),'accel-log-')),reports=[],stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[Math.floor(a.length/2)],p95Ms:a[Math.ceil(a.length*.95)-1]};};
try{
 for(const [kind,text] of Object.entries(calibrationLogFixtures())){
  const reference=calibrationReference.cases[kind];verifyCalibrationInput(text,reference.inputSha256);const name=kind+'.csv',path=join(dir,name);writeFileSync(path,text);const samples:number[]=[];let maxError=0;
  for(let run=0;run<16;run++){const start=performance.now(),datasets=accelerometerDatasets(parseAccelerometerLog(readFileSync(path,'utf8'),name),true);if(run>=5)samples.push(performance.now()-start);maxError=Math.max(maxError,compareCalibrationDatasets(datasets,reference.datasets));}
  const node=stats(samples),historicalPython=stats(reference.samples.slice(5));
  // Offline parsing gate, not a print-loop latency claim. Allow a 5 ms
  // allowance for small tables and bound large FFT inputs against the baseline.
  assert(node.medianMs<=historicalPython.medianMs*1.25+5);assert(node.p95Ms<=historicalPython.p95Ms*1.5+5);
  reports.push({kind,bytes:Buffer.byteLength(text),node,historicalPython,maxError});
 }
 console.log(JSON.stringify({node:process.version,warmups:5,runs:11,reports,referenceCPU:calibrationReference.cpu,scope:'Read/parse/PSD versus fixed original Python/NumPy output; historical performance is not a fresh Python run. Offline computation, no physical printing.'},null,2));
}finally{rmSync(dir,{recursive:true,force:true});}
