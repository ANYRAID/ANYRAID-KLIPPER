import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {max6675Temperature} from '../src/thermal/max6675.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/max6675-reference.json',import.meta.url),'utf8')),raw=Array.from({length:8192},(_,i)=>Math.floor(i/2)*8+i%2),times=[];
for(let run=0;run<9;run++){
 const start=performance.now();let checksum=0;for(let repeat=0;repeat<32;repeat++)for(const value of raw)checksum+=max6675Temperature(value);
 const elapsed=performance.now()-start;assert.equal(checksum,reference.pythonBenchmark.checksum);if(run>=2)times.push(elapsed);
}
times.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,operations:raw.length*32,nodeDecode:{medianMs:times[3],maxMs:times.at(-1)},historicalPython:reference.pythonBenchmark,scope:'All valid MAX6675 codes, 32 repeats; 2 warmups and 7 measured runs. Node includes raw-frame validation. Excludes transport, electrical conversion, hardware precision and printing.'},null,2));
