import {performance} from 'node:perf_hooks';
import {readFileSync} from 'node:fs';
import {EndstopPhaseAlignment,endstopPhaseStatistics} from '../src/homing/endstop-phase.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/endstop-phase-reference.json',import.meta.url),'utf8')) as {pythonStatisticsMs:number[]};
const history=Array.from({length:1024},(_,i)=>BigInt((i*17+3)%7));
function measure(work:()=>void,iterations:number){const samples:number[]=[];for(let round=0;round<12;round++){const start=performance.now();for(let i=0;i<iterations;i++)work();const elapsed=(performance.now()-start)/iterations;if(round>=3)samples.push(elapsed);}samples.sort((a,b)=>a-b);return {iterations,medianMs:samples[4],maxMs:samples.at(-1),samplesMs:samples};}
let checksum=0;
const statistics=measure(()=>{checksum+=endstopPhaseStatistics(history).phase;},100);
const phase=new EndstopPhaseAlignment({microsteps:256,stepDistance:.0125,triggerPhase:{phase:3,phases:1024},alignZero:true});
const correction=measure(()=>{checksum+=phase.adjust((1n<<100n)+1n,3,-.37);},10000);
console.log(JSON.stringify({node:process.version,scope:'Pure correction and 1024-bin statistics; no hardware I/O or motion scheduling',statistics,correction,originalPythonStatisticsMs:reference.pythonStatisticsMs,checksum},null,2));
