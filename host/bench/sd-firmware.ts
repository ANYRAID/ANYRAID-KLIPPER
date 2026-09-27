import assert from 'node:assert/strict';
import {prepareSDFirmware} from '../src/diagnostics/sd-boards.ts';
const input=new Uint8Array(1024*1024).fill(23),results=[];
for(const board of ['btt-skr-mini','mks-robin-e3','chitu-v6']){const samples:number[]=[];let hash='';for(let i=0;i<9;i++){const start=performance.now(),prepared=prepareSDFirmware(board,'stm32f103xe',input);if(i>=2)samples.push(performance.now()-start);if(hash)assert.equal(hash,prepared.sha256);hash=prepared.sha256;}samples.sort((a,b)=>a-b);results.push({board,medianMs:samples[3],maxMs:samples[6]});}
console.log(JSON.stringify({node:process.version,bytes:input.length,warmups:2,samples:7,results,scope:'Board policy, in-process format conversion, detached image and SHA-256; no card IO'}));
