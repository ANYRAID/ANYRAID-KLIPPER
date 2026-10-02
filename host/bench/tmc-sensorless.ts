import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {planTmcSensorless,TmcSensorlessMode,type SensorlessRegister} from '../src/drivers/tmc-sensorless.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/tmc-sensorless-reference.json',import.meta.url),'utf8')) as {rows:{model:string;diag:0|1|null;registers:SensorlessRegister[]}[];historicalPythonMs:number[]};
const planMs:number[]=[],cycleMs:number[]=[],signal=new AbortController().signal;
const device={async write(){}};
for(let round=0;round<11;round++){
 let start=performance.now();for(const r of reference.rows)planTmcSensorless(r.model,r.registers,r.diag??undefined);if(round>=2)planMs.push(performance.now()-start);
 start=performance.now();for(const r of reference.rows){const mode=new TmcSensorlessMode(device,r.model,r.registers,r.diag??undefined,signal,e=>{throw e;});await mode.enter(signal);await mode.restore(signal);}if(round>=2)cycleMs.push(performance.now()-start);
}
console.log(JSON.stringify({scope:'640 mode plans or complete enter/restore cycles; immediate fake acknowledgements; no serial I/O or physical homing',node:process.version,planMs:planMs.sort((a,b)=>a-b),cycleMs:cycleMs.sort((a,b)=>a-b),historicalPythonMs:reference.historicalPythonMs},null,2));
