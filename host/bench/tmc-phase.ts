import {performance} from 'node:perf_hooks';
import {tmcPhaseOffset} from '../src/drivers/tmc-phase.ts';
const timings:number[]=[];let checksum=0;
for(let round=0;round<11;round++){
 const start=performance.now();for(const microsteps of [1,2,4,8,16,32,64,128,256])for(const inverted of [false,true])for(let counter=0;counter<1024;counter++)checksum+=tmcPhaseOffset(counter,microsteps,inverted,-9007199254740993n).offset;
 if(round>=2)timings.push(performance.now()-start);
}
timings.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,scope:'18432 phase conversions per round; 2 warmups, 9 measurements; no serial I/O or stopped-motion barrier',medianMs:timings[4],maximumMs:timings.at(-1),timings,checksum},null,2));
