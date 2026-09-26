// GPL-3.0-or-later. Offline color parsing; no plotting or printer timing.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {motanColor} from '../src/motan/colors.ts';
const ref=JSON.parse(readFileSync(new URL('../contracts/motan-color-performance.json',import.meta.url),'utf8')),samples:number[]=[];
for(let i=0;i<30;i++){
 let checksum=0;const start=performance.now();
 for(let repeat=0;repeat<ref.loops;repeat++)for(const color of ref.inputs){const rgba=motanColor(color,.8);checksum+=rgba[0]+rgba[3];}
 const elapsed=performance.now()-start;if(i>=5)samples.push(elapsed);assert.equal(checksum,ref.checksum);
}
samples.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,resolutions:ref.loops*ref.inputs.length,medianMs:samples[12],p95Ms:samples[23],historicalPython:ref.python,scope:'Color/alpha parsing with fresh independent result arrays. Original Matplotlib uses its warm built-in cache; excludes module load, rendering and print speed.'},null,2));
