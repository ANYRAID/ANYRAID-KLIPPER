import assert from 'node:assert/strict';
import {max31855Temperature} from '../src/thermal/max31855.ts';
const raw=Array.from({length:16384},(_,i)=>i*262144+0x7ff0),samples:number[]=[];let checksum=0;
for(let run=0;run<24;run++){let sum=0;const begin=performance.now();for(let repeat=0;repeat<64;repeat++)for(const word of raw)sum+=max31855Temperature(word);const elapsed=performance.now()-begin;assert.equal(sum,-131072);checksum=sum;if(run>=5)samples.push(elapsed);}
samples.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,decodes:raw.length*64,warmups:5,runs:samples.length,medianMs:samples[9],p95Ms:samples[18],checksum,scope:'Signed MAX31855 wire decoding only; no SPI transport, heater control or hardware'},null,2));
