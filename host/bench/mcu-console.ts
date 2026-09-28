import assert from 'node:assert/strict';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {McuConsole} from '../src/diagnostics/mcu-console.ts';
import {serialFirmware} from '../test/helpers/serial-firmware.ts';
const fw=await serialFirmware(),signal=new AbortController().signal;let responses=0;
const session=new SerialSession(fw.fd,{diagnosticCommands:true,async stopDevice(){},onMessage:r=>{if(r.message.name==='echo_response'){assert.equal(r.message.parameters.value,42);responses++;}}});
try{await session.initialize(signal);const consoleOwner=new McuConsole(session,async()=>{}),samples:number[]=[],commands=1000;
 for(let run=0;run<6;run++){const start=performance.now();for(let i=0;i<commands;i++)await consoleOwner.execute('echo value={40+2}',signal);assert.equal(responses,(run+1)*commands);if(run)samples.push(performance.now()-start);}
 const medianMs=[...samples].sort((a,b)=>a-b)[2];process.stdout.write(JSON.stringify({node:process.version,commands,samplesMs:samples,medianMs,commandsPerSecond:commands/(medianMs/1000),verifiedResponses:responses,scope:'Sequential diagnostic commands including exact arithmetic, native serial queue, simulated firmware responses and ACK waits. Unix local socket; not target UART throughput or physical motion timing.'},null,2)+'\n');
}finally{await session.stop();await fw.close();}
