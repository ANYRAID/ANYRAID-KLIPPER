import {readFileSync} from 'node:fs';
import {calculateScrewTilt} from '../src/motion/screws-tilt.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/screws-tilt-reference.json',import.meta.url),'utf8')),times:number[]=[];let checksum=0;
for(let batch=0;batch<9;batch++){const start=performance.now();for(let i=0;i<10000;i++)checksum+=calculateScrewTilt(reference.rows[i%reference.rows.length].heights,'CW-M3').deviation;if(batch>=2)times.push(performance.now()-start);}
times.sort((a,b)=>a-b);const python=[...reference.pythonTimesMs].sort((a:number,b:number)=>a-b);
console.log(JSON.stringify({node:process.version,iterations:10000,warmups:2,samples:7,medianMs:times[3],maxMs:times[6],historicalPythonMedianMs:python[3],checksum,scope:'Pure screw calculation versus original Python with mock output; no probe travel or equal-work speedup claim.'}));
