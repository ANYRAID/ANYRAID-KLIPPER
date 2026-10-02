import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {serialFirmware} from './helpers/serial-firmware.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {McuConsole} from '../src/diagnostics/mcu-console.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
const signal=()=>new AbortController().signal;
test('diagnostic queues require explicit isolated mode and cannot configure a product session',async()=>{
 for(const diagnosticCommands of [false,true]){const fw=await serialFirmware(),session=new SerialSession(fw.fd,{diagnosticCommands,async stopDevice(){}});try{await session.initialize(signal());if(!diagnosticCommands)assert.throws(()=>session.diagnosticCommandQueue(),/diagnostic/);else{session.diagnosticCommandQueue();assert.throws(()=>session.diagnosticCommandQueue(),/diagnostic/);await assert.rejects(session.configure({} as any,signal()),/unconfigured ready/);}assert.throws(()=>session.commandQueue(),/Configured MCU/);}finally{await session.stop();await fw.close();}}
});
test('console executes raw, delayed and bounded flood commands through native ACK queue',async t=>{
 const fw=await serialFirmware(),responses:number[]=[],session=new SerialSession(fw.fd,{diagnosticCommands:true,async stopDevice(){},onMessage:r=>{if(r.message.name==='echo_response')responses.push(r.message.parameters.value as number);}});let text='';
 try{await session.initialize(signal());const owner=new McuConsole(session,async s=>{text+=s;});
 await owner.execute('SET value 41',signal());await owner.execute('echo value={value+1}',signal());await owner.execute('DELAY {clock + freq * .01} echo value=43',signal());
 const start=performance.now();await owner.execute('FLOOD 25 .001 echo value=44',signal());const elapsed=performance.now()-start;
 assert.deepEqual(responses,[42,43,...Array(25).fill(44)]);await owner.execute('LIST',signal());assert.match(text,/echo value=%u/);assert.match(text,/value=41\/1/);await owner.execute('STATS',signal());assert.match(text,/bytes_write/);
 await owner.execute('SUPPRESS echo_response',signal());assert.equal(owner.response({message:{name:'echo_response',parameters:{value:1}},sentTime:0,receiveTime:serialClock.now()}),undefined);
 const before=responses.length;for(const line of ['FLOOD 10001 .1 echo value=1','FLOOD 5 30 echo value=1','DELAY -1 echo value=1','SET clock 1','echo value={process.exit()}'])await assert.rejects(owner.execute(line,signal()));assert.equal(responses.length,before);
 t.diagnostic(JSON.stringify({commands:25,floodMs:elapsed,scope:'Native queue with simulated firmware, includes scheduling and ACK latency; not hardware timing'}));
 }finally{await session.stop();await fw.close();}
});
test('console memory reads honor width and publish file only after complete read',async()=>{
 const reads:[number,number][]=[],fw=await serialFirmware(undefined,{debugRead:(order,address)=>{reads.push([order,address]);return 0x64636261;}}),session=new SerialSession(fw.fd,{diagnosticCommands:true,async stopDevice(){}}),dir=await mkdtemp('/tmp/mcu-console-');let text='';
 try{await session.initialize(signal());const owner=new McuConsole(session,async s=>{text+=s;});await owner.execute('DUMP 0x1000 4 32',signal());assert.match(text,/00001000  64636261/);assert.deepEqual(reads,[[2,4096]]);
 const target=join(dir,'dump.bin');await owner.execute('FILEDUMP '+target+' 0x2000 5 16',signal());assert.deepEqual(await readFile(target),Buffer.from('ababa'));assert.deepEqual(reads.slice(1),[[1,8192],[1,8194],[1,8196]]);
 const before=reads.length;await assert.rejects(owner.execute('DUMP 0xffffffff 1 32',signal()),/boundary/);assert.equal(reads.length,before);
 const aborted=new AbortController();aborted.abort(Error('cancelled'));await assert.rejects(owner.execute('FILEDUMP '+target+' 0x2000 5',aborted.signal),/cancelled/);assert.deepEqual(await readFile(target),Buffer.from('ababa'));
 }finally{await session.stop();await fw.close();await rm(dir,{recursive:true,force:true});}
});

test('cancel after partial FILEDUMP preserves the previous file and removes temporary output',async()=>{
 const abort=new AbortController(),dir=await mkdtemp('/tmp/mcu-console-cancel-'),target=join(dir,'dump.bin');let reads=0;
 const fw=await serialFirmware(undefined,{debugRead:()=>{if(++reads===5)queueMicrotask(()=>abort.abort(Error('cancel partial dump')));return 0x12345678;}}),session=new SerialSession(fw.fd,{diagnosticCommands:true,async stopDevice(){}});
 try{await writeFile(target,'previous');await session.initialize(signal());const owner=new McuConsole(session,async()=>{});await assert.rejects(owner.execute('FILEDUMP '+target+' 0x1000 32',abort.signal),/cancel partial dump/);assert.equal(reads,5);assert.equal(await readFile(target,'utf8'),'previous');assert.deepEqual(await readdir(dir),['dump.bin']);}finally{await session.stop();await fw.close();await rm(dir,{recursive:true,force:true});}
});
