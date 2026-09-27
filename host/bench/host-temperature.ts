import {readFileSync} from 'node:fs';
import {parseHostTemperature} from '../src/thermal/host-temperature.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/host-temperature-reference.json',import.meta.url),'utf8')),times:number[]=[];let checksum=0;
for(let batch=0;batch<9;batch++){const start=performance.now();for(let i=0;i<10000;i++)checksum+=parseHostTemperature(reference.rows[i%reference.rows.length].raw,-273.15,100);if(batch>=2)times.push(performance.now()-start);}
times.sort((a,b)=>a-b);const python=[...reference.pythonParseTimesMs].sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,iterations:10000,warmups:2,samples:7,nodeMedianMs:times[3],nodeMaxMs:times[6],pythonMedianMs:python[3],pythonMaxMs:python[6],checksum,scope:'Millidegree parsing; TS includes finite/range validation. Original float conversion baseline excludes executor, file I/O and scheduling. Product test measures concurrent printing with async file polling.'}));
