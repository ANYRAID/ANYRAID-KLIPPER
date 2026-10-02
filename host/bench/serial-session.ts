import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialFirmware} from '../test/helpers/serial-firmware.ts';
const firmware=await serialFirmware(),session=new SerialSession(firmware.fd,{async stopDevice(){}}),signal=new AbortController().signal;
try{const start=performance.now();await session.initialize(signal);const initializationMs=performance.now()-start;const latencies:number[]=[];
 for(let i=0;i<1100;i++){const before=performance.now(),response=await session.query(session.dictionary.encode('echo',{value:i}),'echo_response',signal);assert.equal(response.message.parameters.value,i);if(i>=100)latencies.push(performance.now()-before);}
 const cpu=process.cpuUsage(),idle=performance.now();await delay(500);const idleMs=performance.now()-idle,usage=process.cpuUsage(cpu);session.clock.assertActive();assert.equal(session.status.pendingAcks,0);latencies.sort((a,b)=>a-b);
 console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,queries:latencies.length,initializationMs,roundTripMedianMs:latencies[500],roundTripP95Ms:latencies[950],roundTripMaxMs:latencies[999],idleWindowMs:idleMs,idleProcessCpuMs:(usage.user+usage.system)/1000,scope:'Unix stream firmware emulator + native serialqueue + native event-driven bounded receive dispatch + dictionary + ACK dispatch; clock lifecycle initialized and active. No target hardware, Python comparison or motion deadline claim.'},null,2));
}finally{await session.stop();await firmware.close();}
