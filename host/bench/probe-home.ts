import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {probeHomingPosition} from '../src/homing/probe-home.ts';
const ref=JSON.parse(readFileSync(new URL('../contracts/probe-home-reference.json',import.meta.url),'utf8')) as {rows:{halt:number[];trigger:number[];offset:number;expected:number[]}[];pythonTimesMs:number[]};
for(const r of ref.rows)assert.deepEqual(probeHomingPosition(r.halt,r.trigger,r.offset),r.expected);
const samples:number[]=[];let checksum=0;
for(let batch=0;batch<9;batch++){const start=performance.now();for(let i=0;i<10000;i++){const r=ref.rows[i%ref.rows.length];checksum+=probeHomingPosition(r.halt,r.trigger,r.offset)[2];}if(batch>=2)samples.push(performance.now()-start);}
samples.sort((a,b)=>a-b);const python=[...ref.pythonTimesMs].sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,cases:ref.rows.length,iterations:10000,warmups:2,samples:7,nodeMedianMs:samples[3],nodeMaxMs:samples[6],historicalPythonMedianMs:python[3],checksum,scope:'Coordinate correction with validation and array ownership; original Python method timing includes mocked toolhead/probe dispatch. No motion I/O or printer timing.'}));
