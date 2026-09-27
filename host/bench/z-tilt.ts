import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {planZTilt} from '../src/motion/z-tilt.ts';
const {cases}=JSON.parse(readFileSync(new URL('../contracts/z-tilt-reference.json',import.meta.url),'utf8')),samples:number[]=[];
let checksum=0;for(let run=0;run<12;run++){
 let sum=0;const start=performance.now();for(let repeat=0;repeat<100;repeat++)for(const c of cases)sum+=planZTilt(c.samples,c.motors,c.currentZ,10).finalZ;
 const elapsed=performance.now()-start;if(run)assert.equal(sum,checksum);checksum=sum;if(run>=3)samples.push(elapsed);
}
samples.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,plans:cases.length*100,warmups:3,runs:9,medianMs:samples[4],maxMs:samples[8],checksum,scope:'Plane fit and bounded per-motor planning only; no probing, step generation or hardware'},null,2));
