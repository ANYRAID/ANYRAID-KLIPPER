import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {MCUGroup} from '../src/runtime/mcu-group.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialFirmware} from '../test/helpers/serial-firmware.ts';
import type {ScheduledTransport} from '../src/motion/move-queue-sink.ts';
// Capture the raw binding only inside this benchmark, to compare exactly the
// same threads, wire queues and emulators with/without whole-group health checks.
class MeasuredSession extends SerialSession {
 direct:ScheduledTransport|undefined;
 override motionQueue(...args:Parameters<SerialSession['motionQueue']>){const q=super.motionQueue(...args);this.direct=q.transport;return q;}
}
const signal=new AbortController().signal,firmwares=await Promise.all([serialFirmware(),serialFirmware()]),sessions:MeasuredSession[]=[],wrapped:ScheduledTransport[]=[],timings=[{enqueue:[] as number[],ack:[] as number[]},{enqueue:[] as number[],ack:[] as number[]}];
const group=new MCUGroup(firmwares.map((fw,i)=>({id:`mcu${i}`,async connect(signal:AbortSignal,stopDevice:(cause:unknown)=>Promise<void>){const s=new MeasuredSession(fw.fd,{stopDevice});sessions[i]=s;await s.initialize(signal);return s;},async stopDevice(){}})));
try{
 const start=performance.now();await group.start(signal);const startupMs=performance.now()-start;
 for(let i=0;i<2;i++){await sessions[i].configure({oidCount:4,commands:[]},signal);wrapped[i]=group.motionQueue(`mcu${i}`,[`axis${i}`],()=>0n).transport;}
 const payload=Buffer.from(sessions[0].dictionary.encode('set_next_step_dir',{oid:3,dir:1}));const packets=sessions.map((_,i)=>Array.from({length:1000},()=>({id:`axis${i}`,data:payload,minClock:0n,reqClock:0n})));let sent=0;
 for(let round=0;round<111;round++)for(const kind of round%2?[1,0]:[0,1]){const start=performance.now();for(let i=0;i<2;i++)await (kind?wrapped[i]:sessions[i].direct!).send(packets[i]);const enqueue=performance.now()-start,deadline=performance.now()+5000;sent+=1000;while(sessions.some((s,i)=>s.status.pendingAcks||firmwares[i].motion.length<sent)){if(performance.now()>deadline)throw new Error('Group motion benchmark timed out');await delay(1);}if(round>=10){timings[kind].enqueue.push(enqueue);timings[kind].ack.push(performance.now()-start);}}
 for(const fw of firmwares){assert.equal(fw.motion.length,222000);assert.ok(fw.motion.every(m=>m.parameters.oid===3&&m.parameters.dir===1));}
 const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[Math.floor(v.length/2)],p95Ms:v[Math.ceil(v.length*.95)-1]};};
 console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,startupMs,mcusPerGroup:2,messagesPerMCU:1000,warmups:10,samples:101,direct:{enqueue:stats(timings[0].enqueue),ack:stats(timings[0].ack)},group:{enqueue:stats(timings[1].enqueue),ack:stats(timings[1].ack)},scope:'Alternating the same two native sessions with and without MCUGroup motion wrappers; Unix stream emulators, 1ms completion sampling. Not physical multi-MCU timing or print throughput.'},null,2));
}finally{await group.stop();await Promise.all(firmwares.map(fw=>fw.close()));}
