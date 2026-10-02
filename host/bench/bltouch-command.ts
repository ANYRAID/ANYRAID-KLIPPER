import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planBLTouchCommand,type BLTouchCommand} from '../src/homing/bltouch-command.ts';
const ref=JSON.parse(readFileSync(new URL('../contracts/bltouch-command-reference.json',import.meta.url),'utf8')) as {cases:{frequency:number;base:string;command:BLTouchCommand;start:number;duration:number;next:number}[];pythonTimesMs:number[]};
const times:number[]=[];let checksum=0;
for(let batch=0;batch<9;batch++){const start=performance.now();for(let i=0;i<10000;i++){const r=ref.cases[i%ref.cases.length],base=BigInt(r.base),clock={clockAt:(t:number)=>base+BigInt(Math.trunc(t*r.frequency)),secondsToClock:(t:number)=>BigInt(Math.trunc(t*r.frequency)),printAt:(c:bigint)=>Number(c-base)/r.frequency};checksum+=planBLTouchCommand(clock,r.command,r.start,r.duration).next;}if(batch>=2)times.push(performance.now()-start);}
times.sort((a,b)=>a-b);const python=[...ref.pythonTimesMs].sort((a,b)=>a-b);assert(times[3]<=python[3]*1.25+2,'BLTouch planning regressed against captured Python fixture');
console.log(JSON.stringify({node:process.version,cases:ref.cases.length,iterations:10000,nodeMedianMs:times[3],nodeMaxMs:times[6],historicalPythonMedianMs:python[3],checksum,scope:'Command planning and fixture clock construction; captured Python includes mocked PWM dispatch. No physical I/O or print-speed claim.'}));
