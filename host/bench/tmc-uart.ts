import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {encodeTmcRead,encodeTmcWrite,decodeTmcRead} from '../src/drivers/tmc-uart.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/tmc-uart-reference.json',import.meta.url),'utf8')),times:number[]=[];
for(let run=0;run<27;run++){
 const start=performance.now();for(const {address,register,value} of reference.rows){encodeTmcRead(address,register);encodeTmcWrite(address,register,value);assert.equal(decodeTmcRead(register,encodeTmcWrite(255,register,value,true)),value);}if(run>=20)times.push(performance.now()-start);
}
times.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,scope:reference.scope,nodeWarmups:20,nodeMs:{median:times[3],p95:times[6]},historicalPythonMs:{median:reference.historicalPythonMs[3],p95:reference.historicalPythonMs[6]},precision:'uint32 values and frames exact; no physical UART or print throughput measurement'}));
