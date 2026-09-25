import assert from 'node:assert/strict';
import {ServerInformation} from '../src/moonraker/metadata.ts';
import {readNativeHostStatus,type NativeHostSnapshot} from '../src/moonraker/native-host-status.ts';
const info=new ServerInformation({connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'benchmark',missingRequirements:[]});
const source:NativeHostSnapshot={group_state:'ready',hardware_state:'ready',print_state:'idle',homed_axes:'',closing:false,admission_closed:false,maintenance:false,mcus:[{id:'mcu',state:'ready'},{id:'aux',state:'ready'}]};
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]],iterations=100000;let checksum=0;
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const used=process.cpuUsage(),start=performance.now();let ready=0;
 for(let i=0;i<iterations;i++){
  source.closing=i%17===0;const result=info.read(false,i%50);checksum+=result.websocket_count as number;
  if(mode){const full={...result,native_host:readNativeHostStatus(()=>source)};if(full.native_host.ready)ready++;checksum+=full.native_host.mcus.length;}
 }
 const elapsed=(performance.now()-start)*1000/iterations,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/iterations);}
 if(mode)assert.equal(ready,iterations-Math.ceil(iterations/17));
}
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianUs:values[5],p95Us:values[10]};},timing=wall.map(stats),usage=cpu.map(stats),maximumAddedUs=5;
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,iterations,variants:['existingMetadata','metadataWithNativeSnapshot'],timing,cpu:usage,maximumAddedUs,checksum,scope:'Synchronous metadata response construction and bounded validation of a two-MCU snapshot. Excludes HTTP/RPC serialization, device getters and physical printing.'}));
assert(checksum>0);assert(timing[1].medianUs-timing[0].medianUs<maximumAddedUs);assert(timing[1].p95Us-timing[0].p95Us<maximumAddedUs);assert(usage[1].medianUs-usage[0].medianUs<maximumAddedUs);
