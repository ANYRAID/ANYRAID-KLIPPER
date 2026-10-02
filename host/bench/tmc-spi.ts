import {readFileSync} from 'node:fs';
import {encodeTmcSpi} from '../src/drivers/tmc-spi.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/tmc-spi-reference.json',import.meta.url),'utf8')),samples:number[]=[];let bytes=0;
for(let batch=0;batch<9;batch++){const start=performance.now();for(let repeat=0;repeat<20;repeat++)for(const r of reference.rows){bytes+=encodeTmcSpi(r.length,r.position,r.register,r.value).length;bytes+=encodeTmcSpi(r.length,r.position,r.register).length;}if(batch>=2)samples.push(performance.now()-start);}
samples.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,iterations:20,rows:512,warmups:2,batches:7,medianMs:samples[3],maxMs:samples[6],bytes,python:reference.benchmark,scope:'Validated Node Buffer construction versus original Python list construction and owner allocation; no MCU I/O'},null,2));
