import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readAccelerometerLog} from '../src/calibration/accelerometer-file.ts';
import {parseAccelerometerLog,accelerometerDatasets} from '../src/calibration/accelerometer-log.ts';
const dir=await mkdtemp(join(tmpdir(),'accel-file-bench-')),results=[],signal=new AbortController().signal,stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[Math.floor(a.length/2)],p95Ms:a[Math.ceil(a.length*.95)-1]};};
try{for(const count of [8192,65536]){const text=Array.from({length:count},(_,i)=>`${i/3200},${3+200*Math.sin(2*Math.PI*43*i/3200)},${100*Math.cos(2*Math.PI*67*i/3200)},${50*Math.sin(2*Math.PI*123*i/3200)}`).join('\n'),file=join(dir,'raw.csv'),expected=parseAccelerometerLog(text,file),reference=accelerometerDatasets(expected,true),times:number[]=[],total:number[]=[];await writeFile(file,text);for(let run=0;run<16;run++){const start=performance.now(),log=await readAccelerometerLog(file,signal),loaded=performance.now(),data=accelerometerDatasets(log,true),end=performance.now();if(run>=5){times.push(loaded-start);total.push(end-start);}assert.deepEqual(log,expected);assert.deepEqual(data,reference);}results.push({samples:count,bytes:Buffer.byteLength(text),readAndParse:stats(times),includingFftNormalization:stats(total)});}console.log(JSON.stringify({node:process.version,warmups:5,runs:11,results,scope:'Regular file open/stat, bounded streaming strict UTF-8 decoding, parsing; FFT/normalization included separately. Validation outside timer. No Python or printer throughput comparison.'},null,2));}finally{await rm(dir,{recursive:true,force:true});}
