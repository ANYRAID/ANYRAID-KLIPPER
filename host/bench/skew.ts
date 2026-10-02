import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SkewCorrection} from '../src/motion/skew.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/skew-reference.json',import.meta.url),'utf8'));
const skew=new SkewCorrection({xy:.001,xz:-.002,yz:.003}),times:number[]=[];let checksum=0;
for(let batch=0;batch<9;batch++){const start=performance.now();for(let i=0;i<100000;i++)checksum+=skew.apply(reference.rows[i%reference.rows.length].position)[0];if(batch>=2)times.push(performance.now()-start);}
assert.equal(checksum,reference.checksum);times.sort((a,b)=>a-b);const python=[...reference.pythonTimesMs].sort((a:number,b:number)=>a-b);
console.log(JSON.stringify({node:process.version,iterations:100000,warmups:2,samples:7,nodeMedianMs:times[3],nodeMaxMs:times[6],historicalPythonMedianMs:python[3],historicalPythonMaxMs:python[6],checksum,scope:'Validated coordinate transform only; no planner, MCU I/O or printer throughput claim.'}));
