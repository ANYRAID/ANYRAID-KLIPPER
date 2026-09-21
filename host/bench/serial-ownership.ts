import {katapultContract} from './katapult-contract.ts';
import {performance} from 'node:perf_hooks';
import {assertSerialAvailable} from '../src/diagnostics/serial-ownership.ts';
import {ptyPair} from '../test/helpers/pty.ts';
const pair=ptyPair(),warmup=5,runs=11,samples:number[]=[];
function stats(values:number[]){const s=[...values].sort((a,b)=>a-b);return {medianMs:s[Math.floor(s.length/2)],p95Ms:s[Math.ceil(s.length*.95)-1]};}
try{
 let report;for(let i=0;i<warmup+runs;i++){const at=performance.now();report=await assertSerialAvailable(pair.path,new AbortController().signal);if(i>=warmup)samples.push(performance.now()-at);}
 const reference=katapultContract.historicalMeasurements.ownership;
 console.log(JSON.stringify({node:process.version,historicalPython:reference.python,warmup,runs,report,nodeTiming:stats(samples),historicalPythonTiming:reference.pythonTiming,historicalReport:reference.report,scope:'Current Node live /proc scan of idle real PTY; Python timing and the earlier Node scan population are frozen historical evidence. Process/fd population can change; Python validates inode pairs, Node compares character device rdev and uses bounded asynchronous batches. No physical device or printing.'},null,2));
}finally{await pair.close();}
