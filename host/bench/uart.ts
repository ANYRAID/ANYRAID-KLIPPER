import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import {createRequire} from 'node:module';
import {closeSync} from 'node:fs';
import {connectUART} from '../src/protocol/uart.ts';
import {ptyPair,inspectPTY} from '../test/helpers/pty.ts';
import {serialFirmware} from '../test/helpers/serial-firmware.ts';
const native=createRequire(import.meta.url)(process.env.ANYRAID_SERIALQUEUE_ADDON??'../build/serialqueue.node') as {openUART(path:string,baud:number,rts:boolean):number};
const quantiles=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(values.length/2)],p95Ms:values[Math.ceil(values.length*.95)-1]};};
const pair=ptyPair(),open:number[]=[];
try{for(let repeat=0;repeat<14;repeat++){const start=performance.now();for(let i=0;i<500;i++){const fd=native.openUART(pair.path,[115200,250000,123457][i%3],true);closeSync(fd);}if(repeat>=3)open.push(performance.now()-start);}assert.equal(inspectPTY(pair.path).baud,250000);}finally{await pair.close();}
const startup:number[]=[],query:number[]=[];
for(let repeat=0;repeat<13;repeat++){
 const pair=ptyPair();await serialFirmware(pair);const signal=new AbortController().signal;const start=performance.now();
 try{const session=await connectUART(pair.path,{baud:250000,async stopDevice(){}},signal);try{if(repeat>=2)startup.push(performance.now()-start);for(let i=0;i<100;i++){const begin=performance.now();const response=await session.query(session.dictionary.encode('echo',{value:i}),'echo_response',signal);assert.equal(response.message.parameters.value,i);if(repeat>=2)query.push(performance.now()-begin);}}finally{await session.stop();}}finally{await pair.close();}
}
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,openConfigureClose500:quantiles(open),startupWithAVRAndClockWarmup:quantiles(startup),query1100:quantiles(query),scope:'Linux PTY; emulator polls at 1ms. Startup includes required 100+50ms AVR waits and clock warmup. Not physical baud throughput, hardware deadlines, or a Python comparison.'},null,2));
