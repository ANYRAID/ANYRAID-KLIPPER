import assert from 'node:assert/strict';
import {Max31865} from '../src/thermal/max31865.ts';
const model=new Max31865(),positive=process.argv.includes('--positive');
const first=positive?Math.ceil(32768*100/430):model.minimumCode;
const raw=Array.from({length:model.maximumCode-first+1},(_,i)=>(first+i)*2),samples:number[]=[];
const repeats=32;let checksum=0;
for(let run=0;run<24;run++){
 let sum=0;const start=performance.now();
 for(let repeat=0;repeat<repeats;repeat++)for(const value of raw)sum+=model.temperature(value);
 const elapsed=performance.now()-start;assert(Number.isFinite(sum));if(run)assert.equal(sum,checksum);checksum=sum;if(run>=5)samples.push(elapsed);
}
samples.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,nominalResistance:100,referenceResistance:430,firstCode:first,lastCode:model.maximumCode,positiveOnly:positive,decodes:raw.length*repeats,warmups:5,runs:19,medianMs:samples[9],p95Ms:samples[18],checksum,scope:'Valid MAX31865 RTD model codes, scalar decoding only; no serial transport or target hardware'},null,2));
