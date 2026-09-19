import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {encodeFrame} from '../src/protocol/codec.ts';
import {firmwareFault} from '../src/protocol/firmware-fault.ts';
const dictionary=new MessageDictionary();dictionary.identify(Buffer.from(JSON.stringify({commands:{get_clock:2},responses:{'clock clock=%u':3,'stats count=%u':4}})),false);
const frames=Array.from({length:64},(_,i)=>encodeFrame(i&15,i%2?dictionary.encode('clock',{clock:i}):dictionary.encode('stats',{count:i})));
function run(guard:boolean){let sum=0;for(let i=0;i<20000;i++)for(const message of dictionary.parseFrame(frames[i%frames.length])){if(guard){const fault=firmwareFault(message,123);if(fault)throw fault;}sum+=Number(message.parameters.clock??message.parameters.count);}return sum;}
const times=[[],[]] as number[][];
for(let i=0;i<14;i++)for(const guard of i%2?[true,false]:[false,true]){const start=performance.now(),sum=run(guard);const elapsed=performance.now()-start;assert.equal(sum,629488);if(i>=3)times[Number(guard)].push(elapsed);}
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[5],p95Ms:values[10]};};
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,messages:20000,withoutFaultCheck:stats(times[0]),withFaultCheck:stats(times[1]),scope:'Paired decoding of normal MCU frames with and without the mandatory fault classifier; 3 warmups, 11 alternating samples. Not Python or hardware.'},null,2));
