import {readFileSync} from 'node:fs';
import {planManualProbe} from '../src/homing/manual-probe.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/manual-probe-reference.json',import.meta.url),'utf8'));
const times:number[]=[];let checksum=0;
for(let batch=0;batch<9;batch++){
 const start=performance.now();
 for(let i=0;i<10000;i++){const r=reference.rows[i%reference.rows.length];checksum+=planManualProbe(r.position,r.history,r.request).target;}
 if(batch>=2)times.push(performance.now()-start);
}
times.sort((a,b)=>a-b);const python=[...reference.pythonTimesMs].sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,iterations:10000,warmups:2,samples:7,nodeMedianMs:times[3],nodeMaxMs:times[6],historicalPythonMedianMs:python[3],historicalPythonMaxMs:python[6],checksum,scope:'Validated manual target planning versus original TESTZ with mock toolhead and suppressed reporting; excludes HTTP, physical travel and operator response.'}));
