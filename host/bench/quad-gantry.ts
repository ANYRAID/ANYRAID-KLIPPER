import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {planQuadGantry} from '../src/motion/quad-gantry.ts';
const {cases}=JSON.parse(readFileSync(new URL('../contracts/quad-gantry-reference.json',import.meta.url),'utf8')),samples:number[]=[];let checksum=0;
for(let run=0;run<12;run++){
 let sum=0;const start=performance.now();for(let repeat=0;repeat<100;repeat++)for(const c of cases)sum+=planQuadGantry(c.samples,c.corners,['z','z1','z2','z3'],5,10).finalZ;
 const elapsed=performance.now()-start;if(run)assert.equal(sum,checksum);checksum=sum;if(run>=3)samples.push(elapsed);
}
samples.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,plans:3600,warmups:3,runs:9,medianMs:samples[4],maxMs:samples[8],checksum,scope:'Four-corner interpolation and bounded individual motor plan; no probing or physical movement.'},null,2));
