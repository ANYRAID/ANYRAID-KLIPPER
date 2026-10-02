import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {calculateSpectrogram} from '../src/calibration/spectrogram.ts';
import {writeSpectrogram} from '../src/diagnostics/spectrogram-plot.ts';
import {chirpFixture,accelerationBytes} from '../contracts/accelerometer-fixtures.ts';
import {accelerometerReference,verifyAccelerationInput,timing} from '../test/helpers/accelerometer-reference.ts';
const dir=await mkdtemp(join(tmpdir(),'spectrogram-render-')),raw=chirpFixture();verifyAccelerationInput(accelerationBytes(raw),accelerometerReference.plot.inputSha256);
try{const samples:number[]=[];for(let i=0;i<16;i++){const at=performance.now();await writeSpectrogram(calculateSpectrogram(raw),'Spectrogram all (chirp)',200,join(dir,'node.png'),new AbortController().signal);if(i>=5)samples.push(performance.now()-at);}
 const nodePng=timing(samples),historicalPythonPng=timing(accelerometerReference.plot.samples);assert(nodePng.medianMs<=historicalPythonPng.medianMs*1.25+10);assert(nodePng.p95Ms<=historicalPythonPng.p95Ms*1.5+20);
 console.log(JSON.stringify({node:process.version,samples:8192,warmups:5,runs:11,nodePng,historicalPythonPng,scope:'FFT, heatmap and 900x600 PNG. Historical original Matplotlib timing, different palettes/layout; no pixel or physical timing equivalence claim.'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
