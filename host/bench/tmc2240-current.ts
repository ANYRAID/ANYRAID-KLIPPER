import {readFileSync} from 'node:fs';import {performance} from 'node:perf_hooks';
import {tmc2240Current} from '../src/drivers/tmc2240-current.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/tmc2240-current-reference.json',import.meta.url),'utf8')) as {rows:[number,number,number,number|null,...number[]][];pythonMs:number[]};
const samples:number[]=[];let checksum=0;
for(let round=0;round<12;round++){const start=performance.now();for(const [rref,run,hold,fixed] of reference.rows){const r=tmc2240Current(run,hold,rref,fixed??undefined);checksum+=r.globalscaler+r.irun+r.ihold;}if(round>=3)samples.push(performance.now()-start);}
samples.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,scope:'Current conversion only; original Python helper includes field dictionary dispatch; no device I/O',cases:reference.rows.length,medianMs:samples[4],maxMs:samples.at(-1),samplesMs:samples,pythonMs:reference.pythonMs,checksum},null,2));
