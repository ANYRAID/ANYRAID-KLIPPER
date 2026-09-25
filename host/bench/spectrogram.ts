import assert from 'node:assert/strict';
import {calculateSpectrogram} from '../src/calibration/spectrogram.ts';
import {spectrogramFixture,accelerationBytes} from '../contracts/accelerometer-fixtures.ts';
import {accelerometerReference,verifyAccelerationInput,compareSpectrogram,timing} from '../test/helpers/accelerometer-reference.ts';
for(const [id,ref] of Object.entries(accelerometerReference.spectra)){
 const raw=spectrogramFixture(ref.n,ref.rate);verifyAccelerationInput(accelerationBytes(raw),ref.inputSha256);const samples:number[]=[];let result=calculateSpectrogram(raw,ref.axis);
 for(let i=0;i<16;i++){const at=performance.now();result=calculateSpectrogram(raw,ref.axis);if(i>=5)samples.push(performance.now()-at);}
 const maxAbsoluteError=compareSpectrogram(result,ref),nodeCompute=timing(samples),historicalPython=timing(ref.samples);
 assert(nodeCompute.medianMs<=historicalPython.medianMs*1.25+2);assert(nodeCompute.p95Ms<=historicalPython.p95Ms*1.5+2);
 console.log(JSON.stringify({node:process.version,id,fftSize:result.fftSize,frames:result.frames,warmups:5,runs:11,nodeCompute,historicalPython,maxAbsoluteError,scope:'Fixed original matplotlib.mlab matrix; historical timing, no Python process. Parsed input, allocation/validation/FFT; no printer timing.'}));
}
