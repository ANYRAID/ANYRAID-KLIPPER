import assert from 'node:assert/strict';
import {max31856Temperature} from '../src/thermal/max31856.ts';
const positive=process.argv.includes('--positive'),count=positive?262144:524288,repeats=positive?4:2;
const raw=Array.from({length:count},(_,code)=>code*32+(code%32)),samples:number[]=[];let checksum=0;
for(let run=0;run<24;run++){
 let sum=0;const start=performance.now();
 for(let repeat=0;repeat<repeats;repeat++)for(const value of raw)sum+=max31856Temperature(value);
 const elapsed=performance.now()-start;assert.equal(sum,positive?1073737728:-4096);checksum=sum;if(run>=5)samples.push(elapsed);
}
samples.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,positiveOnly:positive,decodes:1048576,warmups:5,runs:19,medianMs:samples[9],p95Ms:samples[18],checksum,scope:'MAX31856 scalar decoding with unspecified low bits; no SPI transport, firmware, heater control or actual hardware'},null,2));
