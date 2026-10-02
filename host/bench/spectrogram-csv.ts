import assert from 'node:assert/strict';
import {spectrogramCsv} from '../src/calibration/spectrogram-csv.ts';
import {spectrogramCsvFixture} from '../contracts/accelerometer-fixtures.ts';
import {accelerometerReference,compareSpectrogramCsv,timing} from '../test/helpers/accelerometer-reference.ts';
const data=spectrogramCsvFixture(),samples:number[]=[];let csv='';
for(let i=0;i<16;i++){const at=performance.now();csv=spectrogramCsv(data);if(i>=5)samples.push(performance.now()-at);}
const error=compareSpectrogramCsv(csv,data),nodeSerialize=timing(samples),historicalPython=timing(accelerometerReference.csv.samples);assert(nodeSerialize.medianMs<=historicalPython.medianMs*1.25+2);assert(nodeSerialize.p95Ms<=historicalPython.p95Ms*1.5+2);
console.log(JSON.stringify({node:process.version,frames:data.frames,bins:data.frequencies.length,warmups:5,runs:11,nodeSerialize,historicalPython,nodeBytes:Buffer.byteLength(csv),pythonBytes:Buffer.byteLength(accelerometerReference.csv.csv),...error,scope:'Fixed original rounded CSV; historical Python StringIO timing. Node validates and preserves doubles; FFT/disk/startup excluded, no Python execution.'},null,2));
