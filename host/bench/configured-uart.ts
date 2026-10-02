import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {configuredUARTConnections} from '../src/runtime/configured-uart.ts';
const sections:Record<string,Record<string,string>>={},policies=new Map();
let stops=0;
for(let i=0;i<16;i++){const id=i?`aux${i}`:'mcu';sections[i?`mcu ${id}`:'mcu']={serial:`/not-opened/tty${i}`,baud:String(i%2?115200:250000)};policies.set(id,{stopDevice:async()=>{stops++;},rts:true,leaveBootloader:false});}
const reader=new ConfigurationReader(new ConfigurationSource('/bench.cfg',sections,[]),null),wall:number[]=[],cpu:number[]=[],iterations=1000,budgetMsPerCompile=1;
for(let run=0;run<14;run++){
 const used=process.cpuUsage(),start=performance.now();
 for(let i=0;i<iterations;i++){const connections=configuredUARTConnections(reader,policies);assert.equal(connections.length,16);assert.equal(connections[0].id,'mcu');}
 const elapsed=(performance.now()-start)/iterations,usage=process.cpuUsage(used);if(run>=3){wall.push(elapsed);cpu.push((usage.user+usage.system)/1000/iterations);}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=stats(wall),usage=stats(cpu);
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,iterations,mcus:16,budgetMsPerCompile,timing,cpu:usage,scope:'Compile UART configuration and snapshot 16 machine policies into unopened connectors; no device acquisition or physical printing.'}));
assert.equal(stops,0);assert(timing.p95Ms<budgetMsPerCompile);
