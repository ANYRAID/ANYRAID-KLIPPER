import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {MCUGroup,uartMCU,type MCUConnection} from '../src/runtime/mcu-group.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
import {ptyPair} from './helpers/pty.ts';
const signal=()=>new AbortController().signal;
async function until(check:()=>boolean){const end=performance.now()+2000;while(!check()){if(performance.now()>end)throw new Error('MCU group fixture timeout');await delay(1);}}
async function fixture(stop?:(id:number,cause:unknown)=>Promise<void>){const firmwares=await Promise.all([serialFirmware(),serialFirmware()]),sessions:SerialSession[]=[],stops=[0,0];const entries:MCUConnection[]=firmwares.map((fw,i)=>({id:`mcu${i}`,async connect(signal,stopDevice){const s=new SerialSession(fw.fd,{stopDevice});sessions[i]=s;await s.initialize(signal);return s;},async stopDevice(cause){stops[i]++;await stop?.(i,cause);}}));return {firmwares,sessions,stops,entries,async close(){await Promise.all(firmwares.map(fw=>fw.close()));}};}
test('group only becomes ready after all clocks, provides sessions and cannot restart',async()=>{
 const f=await fixture(),group=new MCUGroup(f.entries);try{await group.start(signal());group.assertActive();assert.equal(group.status.state,'ready');assert.equal(group.session('mcu0'),f.sessions[0]);assert.throws(()=>group.session('unknown'),/Unknown/);await assert.rejects(group.start(signal()),/restart/);const stop=group.stop();assert.equal(group.stop(),stop);await stop;assert.deepEqual(f.stops,[1,1]);assert.ok(f.sessions.every(s=>s.status.state==='closed'&&!s.clock.sync.active));assert.throws(()=>group.assertActive(),/not ready/);}finally{await group.stop();await f.close();}
});
test('one firmware fault stops every MCU and rejects both backpressured motion tails',async()=>{
 const f=await fixture(),group=new MCUGroup(f.entries);try{await group.start(signal());const sends=[];
 for(let i=0;i<2;i++){const session=group.session(`mcu${i}`);await session.configure({oidCount:4,commands:[]},signal());const transport=group.motionQueue(`mcu${i}`,[`axis${i}`],_t=>0n).transport;const future=session.clock.sync.getClock(serialClock.now()+10),data=Buffer.from(session.dictionary.encode('set_next_step_dir',{oid:3,dir:1}));sends.push(assert.rejects(transport.send(Array.from({length:5000},()=>({id:`axis${i}`,data,minClock:future,reqClock:future}))),/closed|ready/));}
 f.firmwares[0].emit('shutdown',{clock:42,static_string_id:'Timer too close'});await Promise.all(sends);await group.stop();assert.deepEqual(f.stops,[1,1]);assert.equal(group.status.state,'stopped');assert.match(String(group.status.fault),/Timer too close/);assert.ok(f.sessions.every(s=>s.status.pendingAcks===0&&s.status.state==='closed'));assert.ok(f.firmwares.every(fw=>fw.motion.length===0));
 }finally{await group.stop();await f.close();}
});
test('fault while connections are warming aborts all startup and preserves original reason',async()=>{
 const f=await fixture();f.firmwares[0].ignore('get_uptime');const group=new MCUGroup(f.entries);try{const start=group.start(signal()),rejected=assert.rejects(start,/MCU shutdown/);await until(()=>f.sessions[0]?.status.state==='warming');f.firmwares[0].emit('is_shutdown',{static_string_id:'Command request'});await rejected;assert.deepEqual(f.stops,[1,1]);assert.ok(f.sessions.every(s=>s.status.state==='closed'));assert.equal(group.status.state,'stopped');}finally{await group.stop();await f.close();}
});
test('failed connector aborts peers and invokes every attempted independent safety path',async()=>{
 let attempts=0,stops=0;const entries:MCUConnection[]=[{id:'bad',async connect(){attempts++;throw new Error('port absent');},async stopDevice(){stops++;}},{id:'waiting',async connect(signal){attempts++;return await new Promise((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});},async stopDevice(){stops++;}}];const group=new MCUGroup(entries);await assert.rejects(group.start(signal()),/port absent/);assert.equal(attempts,2);assert.equal(stops,2);assert.equal(group.status.state,'stopped');
});
test('late connector cannot publish a ready session after stop or let stop finish early',async()=>{
 const fw=await serialFirmware(),gate=Promise.withResolvers<void>();let returned:SerialSession|undefined,stops=0;const group=new MCUGroup([{id:'late',async connect(_signal,stopDevice){const s=new SerialSession(fw.fd,{stopDevice});await s.initialize(signal());returned=s;await gate.promise;return s;},async stopDevice(){stops++;}}]);
 try{const started=group.start(signal()),rejected=assert.rejects(started,/cancel group/);await until(()=>!!returned);let finished=false;const stopped=group.stop(new Error('cancel group')).then(()=>{finished=true;});await delay(10);assert.equal(finished,false);assert.equal(stops,1);assert.equal(group.status.state,'stopping');gate.resolve();await stopped;await rejected;assert.equal(returned!.status.state,'closed');assert.equal(group.status.state,'stopped');assert.equal(stops,1);}finally{gate.resolve();await group.stop();await fw.close();}
});
test('one failed safety handler does not prevent peer stop and remains visible',async()=>{
 const f=await fixture(async id=>{if(id===0)throw new Error('watchdog failed');}),group=new MCUGroup(f.entries);try{await group.start(signal());await assert.rejects(group.stop(new Error('cancel all')),/group stop failed/);assert.deepEqual(f.stops,[1,1]);assert.ok(f.sessions.every(s=>s.status.state==='closed'));assert.equal(group.status.state,'failed');assert.match(String(group.status.fault),/cancel all/);assert.ok(group.status.stopError instanceof AggregateError);}finally{await group.stop().catch(()=>{});await f.close();}
});
test('reentrant safety notification does not deadlock group shutdown',async()=>{
 let group:MCUGroup;const f=await fixture(async(_id,cause)=>{void group.stop(cause).catch(()=>{});});group=new MCUGroup(f.entries);try{await group.start(signal());f.firmwares[1].emit('starting');await until(()=>group.status.state==='stopped');assert.deepEqual(f.stops,[1,1]);}finally{await group.stop();await f.close();}
});
test('pre-aborted startup and invalid group declarations acquire no devices',async()=>{
 let calls=0;const entry:MCUConnection={id:'a',async connect(){calls++;throw new Error('unexpected');},async stopDevice(){calls++;}};assert.throws(()=>new MCUGroup([]),/Invalid/);assert.throws(()=>new MCUGroup([entry,entry]),/Invalid/);assert.throws(()=>new MCUGroup(Array.from({length:17},(_,i)=>({...entry,id:String(i)}))),/Invalid/);const group=new MCUGroup([entry]),abort=new AbortController();abort.abort(new Error('cancel before start'));await assert.rejects(group.start(abort.signal),/cancel before start/);assert.equal(calls,0);assert.equal(group.status.state,'stopped');
});
test('UART factory connects a real PTY through the group lifecycle',async()=>{
 const pair=ptyPair();await serialFirmware(pair);let stops=0;const group=new MCUGroup([uartMCU('mcu',pair.path,{baud:250000,leaveBootloader:false,async stopDevice(){stops++;}})]);try{await group.start(signal());assert.equal(group.session('mcu').status.state,'ready');await group.stop();assert.equal(stops,1);}finally{await group.stop();await pair.close();}
});
test('a slow safety acknowledgement cannot delay stopping peer host queues',async()=>{
 const gate=Promise.withResolvers<void>(),f=await fixture(async id=>{if(id===0)await gate.promise;}),group=new MCUGroup(f.entries);try{await group.start(signal());let finished=false;const stopped=group.stop().then(()=>{finished=true;});await until(()=>f.stops[1]===1);assert.deepEqual(f.stops,[1,1]);assert.ok(f.sessions.every(s=>s.status.state==='closed'));assert.equal(finished,false);assert.equal(group.status.state,'stopping');gate.resolve();await stopped;assert.equal(group.status.state,'stopped');}finally{gate.resolve();await group.stop();await f.close();}
});
