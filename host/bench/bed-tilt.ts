import {readFileSync} from 'node:fs';
import {BedTilt,fitBedTilt} from '../src/motion/bed-tilt.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/bed-tilt-reference.json',import.meta.url),'utf8'));
const tilt=new BedTilt({x:.001,y:-.003,z:.2}),times:number[]=[];let checksum=0;
for(let batch=0;batch<9;batch++){const start=performance.now();for(let i=0;i<10000;i++)checksum+=tilt.apply(reference.rows[i%reference.rows.length].position)[2];if(batch>=2)times.push(performance.now()-start);}
times.sort((a,b)=>a-b);const python=[...reference.pythonTimesMs].sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,iterations:10000,warmups:2,samples:7,nodeMedianMs:times[3],nodeMaxMs:times[6],historicalPythonMedianMs:python[3],historicalPythonMaxMs:python[6],checksum,scope:'Validated forward plane transform versus original Python move with mock toolhead; no MCU or printer throughput claim.'}));
const fitTimes:number[]=[];for(let batch=0;batch<9;batch++){const start=performance.now();for(let i=0;i<1000;i++)checksum+=fitBedTilt(reference.fits[i%reference.fits.length].points).adjust.z;if(batch>=2)fitTimes.push(performance.now()-start);}fitTimes.sort((a,b)=>a-b);const pythonFit=[...reference.pythonFitTimesMs].sort((a,b)=>a-b);console.log(JSON.stringify({kind:'fit',iterations:1000,nodeMedianMs:fitTimes[3],nodeMaxMs:fitTimes[6],historicalPythonMedianMs:pythonFit[3],historicalPythonMaxMs:pythonFit[6],checksum,scope:'Plane least squares, no probing or MCU I/O.'}));
