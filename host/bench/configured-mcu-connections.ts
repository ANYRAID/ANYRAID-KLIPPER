import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {configuredMCUConnections} from '../src/runtime/configured-mcu-connections.ts';
const sections:Record<string,Record<string,string>>={},policies=new Map();
let stops=0;
for(let i=0;i<16;i++){const id=i?`aux${i}`:'mcu';const transport=i%3===0?'uart':i%3===1?'can':'pipe';sections[i?`mcu ${id}`:'mcu']=transport==='can'?{canbus_uuid:(i+1).toString(16)}:{serial:transport==='pipe'?`/tmp/klipper_host_bench${i}`:`/not-opened/tty${i}`};policies.set(id,{transport,stopDevice:async()=>{stops++;},rts:true,leaveBootloader:false,nodeId:64+i,timeoutMs:5000});}
const reader=new ConfigurationReader(new ConfigurationSource('/bench.cfg',sections,[]),null),wall:number[]=[],cpu:number[]=[],iterations=1000,budgetMsPerCompile=1;
for(let run=0;run<14;run++){
 const used=process.cpuUsage(),start=performance.now();
 for(let i=0;i<iterations;i++){const connections=configuredMCUConnections(reader,policies);assert.equal(connections.length,16);assert.equal(connections[0].id,'mcu');}
 const elapsed=(performance.now()-start)/iterations,usage=process.cpuUsage(used);if(run>=3){wall.push(elapsed);cpu.push((usage.user+usage.system)/1000/iterations);}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=stats(wall),usage=stats(cpu);
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,iterations,mcus:16,budgetMsPerCompile,timing,cpu:usage,scope:'Compile mixed UART/CAN/character-device configuration and snapshot 16 machine policies into unopened connectors; no device acquisition or physical printing.'}));
assert.equal(stops,0);assert(timing.p95Ms<budgetMsPerCompile);
