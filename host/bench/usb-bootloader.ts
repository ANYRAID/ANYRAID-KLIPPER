import assert from 'node:assert/strict';
import {flashContract} from './flash-usb-reference.ts';
import {performance} from 'node:perf_hooks';
import {enterUsbBootloader} from '../src/diagnostics/usb-bootloader.ts';
import {ptyPair} from '../test/helpers/pty.ts';
const pair=ptyPair(),warmup=5,runs=31,batch=1000;
function stats(values:number[]){const s=[...values].sort((a,b)=>a-b);return {medianMs:s[Math.floor(s.length/2)],p95Ms:s[Math.ceil(s.length*.95)-1]};}
try{
 const samples:number[]=[],signal=new AbortController().signal;
 for(let i=0;i<warmup+runs;i++){const at=performance.now();for(let j=0;j<batch;j++){let failed=false;try{await enterUsbBootloader(pair.path,signal);}catch(error){assert.match(String(error),/Raise USB bootloader DTR/);failed=true;}assert.ok(failed);}if(i>=warmup)samples.push(performance.now()-at);}
 console.log(JSON.stringify({node:process.version,historicalReference:flashContract.provenance,warmup,runs,batch,scope:'Real PTY failure at first DTR ioctl only. Node includes flock and observable rejected Promise/assertion; Python silently swallows the same unsupported ioctl. Does not measure successful physical bootloader entry or printing.',nodeTiming:stats(samples),historicalPythonTiming:flashContract.historicalMeasurements.touch.pythonTiming},null,2));
}finally{await pair.close();}
