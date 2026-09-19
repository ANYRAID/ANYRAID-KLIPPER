import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialFirmware} from '../test/helpers/serial-firmware.ts';
const fw=await serialFirmware(),s=new SerialSession(fw.fd,{async stopDevice(){}}),enqueue:number[]=[],complete:number[]=[],count=2000;
try{await s.initialize(new AbortController().signal);await s.configure({oidCount:4,commands:[]},new AbortController().signal);const transport=s.motionTransport(['x']);const data=Buffer.from(s.dictionary.encode('set_next_step_dir',{oid:3,dir:1})),packets=Array.from({length:count},()=>({id:'x',data,minClock:0n,reqClock:0n}));
 for(let run=0;run<14;run++){const start=performance.now();await transport.send(packets);const accepted=performance.now()-start;const deadline=performance.now()+5000;while(s.status.pendingAcks||fw.motion.length<(run+1)*count){if(performance.now()>deadline)throw new Error('Motion benchmark timed out');await delay(1);}if(run>=3){enqueue.push(accepted);complete.push(performance.now()-start);}}
 assert.equal(fw.motion.length,14*count);assert.ok(fw.motion.every(m=>m.parameters.oid===3&&m.parameters.dir===1));enqueue.sort((a,b)=>a-b);complete.sort((a,b)=>a-b);
 console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,messagesPerBatch:count,enqueueMedianMs:enqueue[5],enqueueP95Ms:enqueue[10],acknowledgedMedianMs:complete[5],acknowledgedP95Ms:complete[10],scope:'Includes validation, payload copies, native scheduled enqueue, framing, emulator and ACK dispatch; completion sampled every 1 ms. UART wire speed, real MCU execution and target-board deadline gates are not measured.'},null,2));
}finally{await s.stop();await fw.close();}
