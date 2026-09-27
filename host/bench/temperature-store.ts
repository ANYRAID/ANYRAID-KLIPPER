import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {TemperatureStore} from '../src/moonraker/temperature-store.ts';

const sensors=Array.from({length:32},(_,i)=>'sensor '+i),frames=Array.from({length:64},(_,i)=>Object.fromEntries(sensors.map((name,j)=>[name,{temperature:200+Math.sin((i+j)/20),target:210,power:(i+j)/100,speed:j/32}]))),samples=1000;
const measurements:Record<string,{medianMs:number;p95Ms:number}>={};
function stats(values:number[]){values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(values.length/2)],p95Ms:values.at(-1)!};}
for(const mode of ['stable','varying']){
 const times:number[]=[];
 for(let run=0;run<9;run++){const store=new TemperatureStore();store.configure(sensors,[],frames[0]);const start=performance.now();for(let i=0;i<samples;i++)store.sample(frames[mode==='stable'?0:i%frames.length]);const elapsed=performance.now()-start;assert.equal(store.snapshot()[sensors[0]].temperatures.length,samples+1);if(run>=2)times.push(elapsed);}
 measurements[mode]=stats(times);
}
const python=JSON.parse(readFileSync(new URL('../contracts/temperature-store-reference.json',import.meta.url),'utf8')).benchmark.pythonHistory;
console.log(JSON.stringify({node:process.version,sensors:32,fieldsPerSensor:4,samples,nodeHistory:measurements,historicalPythonHistory:python,scope:'1000 synchronous callbacks; fixed historical Python baseline, no Python runtime. Excludes I/O, timers, JSON serialization and target hardware'},null,2));
