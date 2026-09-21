import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {MCUGroup} from '../src/runtime/mcu-group.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialFirmware} from '../test/helpers/serial-firmware.ts';
const fw=await Promise.all([serialFirmware(),serialFirmware()]),sessions:SerialSession[]=[],signal=new AbortController().signal,times:number[]=[];
const group=new MCUGroup(fw.map((f,i)=>({id:'m'+i,async connect(signal,stopDevice){const s=new SerialSession(f.fd,{stopDevice});sessions[i]=s;await s.initialize(signal);return s;},async stopDevice(){}})));
try{await group.start(signal);const targets={m0:sessions[0].clock.sync.lastClock-1n,m1:sessions[1].clock.sync.lastClock-1n};for(let i=0;i<16;i++){await new Promise<void>(resolve=>setImmediate(resolve));const start=performance.now();for(let j=0;j<1000;j++)await group.waitForMotionClocks(targets,signal);if(i>=5)times.push(performance.now()-start);}assert.equal(group.status.state,'ready');assert.ok(sessions.every(s=>s.status.state==='ready'));times.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,mcus:2,barriersPerBatch:1000,medianMs:times[5],p95Ms:times[10],scope:'Real native serial sessions with Unix-stream firmware emulators; ACK snapshot plus already-passed sampled clock targets. Initialization and future-clock latency excluded; no physical motion verification.'},null,2));}finally{await group.stop();await Promise.all(fw.map(f=>f.close()));}
