import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TemperatureFanControl} from '../src/thermal/temperature-fan.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/temperature-fan-reference.json',import.meta.url),'utf8'));
const timings:number[]=[];let checksum=0;
for(let run=0;run<12;run++){
 let sum=0;const start=performance.now();
 for(let repeat=0;repeat<200;repeat++)for(const c of reference.cases){
  const fan=new TemperatureFanControl(reference.settings,c.algorithm,reference.reportDelay);
  for(const row of c.samples){const event=fan.sample(row.time,row.temperature);if(event)sum+=event.speed+event.time;}
 }
 const elapsed=performance.now()-start;if(run)assert.equal(sum,checksum);checksum=sum;if(run>=3)timings.push(elapsed);
}
timings.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,samples:96000,warmups:3,runs:9,medianMs:timings[4],maxMs:timings[8],checksum,scope:'Control computation and output suppression only; excludes sensor IO, MCU scheduling and hardware'},null,2));
