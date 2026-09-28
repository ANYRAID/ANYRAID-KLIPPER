import assert from 'node:assert/strict';
import {substituteConsoleArithmetic} from '../src/diagnostics/console-arithmetic.ts';
const variables=new Map([['clock',9007199254740993n],['freq',1000000n]]),samples:number[]=[],iterations=10000;
for(let run=0;run<6;run++){
 const start=performance.now();for(let i=0;i<iterations;i++)assert.equal(substituteConsoleArithmetic('DELAY {clock + freq * .2} reset_step_clock oid=4 clock={(clock + freq * .2) & 0xffffffff}',variables),'DELAY 9007199254940993 reset_step_clock oid=4 clock=200001');if(run)samples.push(performance.now()-start);
}
const median=[...samples].sort((a,b)=>a-b)[2];process.stdout.write(JSON.stringify({node:process.version,iterations,expressionsPerCommand:2,samplesMs:samples,medianMs:median,commandsPerSecond:iterations/(median/1000),scope:'Local exact arithmetic substitution and result assertion only; no transport, scheduling or physical motion. Arithmetic component of the diagnostic console.'},null,2)+'\n');
