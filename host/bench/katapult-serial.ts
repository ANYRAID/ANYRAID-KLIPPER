import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {flashKatapult} from '../src/diagnostics/katapult.ts';
import {openKatapultSerial} from '../src/diagnostics/katapult-serial.ts';
import {katapultPTY} from '../test/helpers/katapult-pty.ts';
const warmup=5,runs=11,image=Buffer.alloc(4093,0x99),samples:number[]=[];
for(let i=0;i<warmup+runs;i++){
 const peer=katapultPTY({prime:true}),signal=new AbortController().signal;const at=performance.now();let serial:ReturnType<typeof openKatapultSerial>|undefined;
 try{serial=openKatapultSerial(peer.path,{prime:true},signal);const result=await flashKatapult(image,serial,signal);serial.close();const elapsed=performance.now()-at;assert.equal(result.blocks,16);assert.equal(peer.commands.length,36);assert.equal(peer.commands.at(-1),0x15);if(i>=warmup)samples.push(elapsed);}finally{serial?.close();await peer.close();}
}
const sorted=samples.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,warmup,runs,imageBytes:image.length,commandsIncludingPrime:36,medianMs:sorted[Math.floor(runs/2)],p95Ms:sorted[Math.ceil(runs*.95)-1],scope:'Real PTY open/configuration/lock, priming, complete flash/readback and close. Firmware simulator polls PTY at 1 ms; host polls nonblocking reads at 1 ms. No Python full-transport comparator, physical USB timing or print throughput.'},null,2));
