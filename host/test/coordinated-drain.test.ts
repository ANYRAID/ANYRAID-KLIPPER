import test from 'node:test';
import assert from 'node:assert/strict';
import {MCUGroup} from '../src/runtime/mcu-group.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
import {MoveQueueSink} from '../src/motion/move-queue-sink.ts';
import {CoordinatedMotionDrain} from '../src/motion/coordinated-drain.ts';
async function fixture(run:(drain:CoordinatedMotionDrain,g:MCUGroup,c:MotionCoordinator,q:TrapQueue,fw:Awaited<ReturnType<typeof serialFirmware>>,end:number)=>Promise<void>,retainHistory:()=>Promise<void>=async()=>{},pressure=false){const fw=await serialFirmware(),signal=new AbortController().signal;let session!:SerialSession;const g=new MCUGroup([{id:'m',async connect(s,stopDevice){session=new SerialSession(fw.fd,{stopDevice});await session.initialize(s);return session;},async stopDevice(){}}]);try{await g.start(signal);await session.configure({oidCount:4,commands:[]},signal);const start=Number(session.clock.sync.lastClock)/1e6+.1,end=start+.1;using q=new TrapQueue();if(pressure)q.appendRaw(new Float64Array([0,0,start,0,0,0,0,0,0,0,0,0,0]));q.appendRaw(new Float64Array([start,0,.1,0,0,0,0,1,0,0,10,10,0]));using step=q.createStepper({frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:8,directionTag:9},pressure?'extruder':'x',.01);if(pressure)step.configurePressureAdvance(.05,.04);const sink=new MoveQueueSink([g.motionQueue('m',['x'],t=>step.clockAt(t))],retainHistory),c=new MotionCoordinator([{id:'x',queue:q,stepper:step}],sink,16*1024*1024,0,[session.clock]);await run(new CoordinatedMotionDrain(c,sink,g),g,c,q,fw,end);}finally{await g.stop();await fw.close();}}
test('native generation routes to serial firmware then waits beyond the complete motion boundary',async()=>fixture(async(d,g,c,q,fw,end)=>{const result=await d.drain(end,new Map([[q,[1,0,0] as const]]),new AbortController().signal,3000);assert.ok(g.session('m').clock.sync.lastClock>result.targets.m);assert.equal(c.status.committedTime,result.generatedUntil);assert.ok(result.sourceUntil>result.generatedUntil);assert.equal(fw.motion.filter(m=>m.name==='queue_step').reduce((sum,m)=>sum+Number(m.parameters.count),0),100);assert.equal(g.status.state,'ready');}));
test('cancellation fences native generation and the entire MCU group',async()=>fixture(async(d,g,c,q,_fw,end)=>{const controller=new AbortController(),cause=new Error('cancel unified drain'),running=d.drain(end,new Map([[q,[1,0,0] as const]]),controller.signal,3000);const rejected=assert.rejects(running,/cancel|stopped|closed/);controller.abort(cause);await rejected;assert.equal(c.status.failed,true);assert.equal(g.status.state,'stopped');}));
test('concurrent drains are rejected and one deadline covers the complete operation',async()=>fixture(async(d,g,c,q,_fw,end)=>{const p=d.drain(end,new Map([[q,[1,0,0] as const]]),new AbortController().signal,20);const failed=assert.rejects(p,/timed out/);await assert.rejects(d.drain(end,new Map([[q,[1,0,0] as const]]),new AbortController().signal),/already active/);await failed;assert.equal(c.status.failed,true);assert.equal(g.status.state,'stopped');}));

test('deadline rejects an unresponsive history hook and late completion cannot send packets',async()=>{let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});await fixture(async(d,g,c,q,fw,end)=>{await assert.rejects(d.drain(end,new Map([[q,[1,0,0] as const]]),new AbortController().signal,20),/timed out/);assert.equal(g.status.state,'stopped');assert.equal(c.status.failed,true);assert.equal(fw.motion.length,0);release();await new Promise<void>(r=>setImmediate(r));assert.equal(fw.motion.length,0);},()=>gate);});
test('streaming commit shares cancellation deadline and fences an unresponsive history hook',async()=>{let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});await fixture(async(d,g,c,q,fw,end)=>{const pending=d.advanceSource(end,new AbortController().signal,20),rejected=assert.rejects(pending,/timed out/);await assert.rejects(d.drain(end,new Map([[q,[1,0,0] as const]]),new AbortController().signal),/already active/);await rejected;assert.equal(g.status.state,'stopped');assert.equal(c.status.failed,true);assert.equal(fw.motion.length,0);release();await new Promise<void>(r=>setImmediate(r));assert.equal(fw.motion.length,0);},()=>gate);});

test('drained native coordinator retires through the MCU group and releases its motion lease',async()=>fixture(async(d,g,c,q,fw,end)=>{
 const signal=new AbortController().signal;
 const result=await d.drain(end,new Map([[q,[1,0,0] as const]]),signal,3000);
 assert(g.session('m').clock.sync.lastClock>result.targets.m);
 await c.retire(signal);assert.equal(c.status.retired,true);assert.equal(c.status.failed,false);g.assertActive();
 const s=g.session('m'),replacement=g.motionQueue('m',['x'],()=>0n).transport;
 await replacement.send([{id:'x',data:Buffer.from(s.dictionary.encode('set_next_step_dir',{oid:3,dir:0})),minClock:0n,reqClock:0n}]);
 await replacement.retire!(signal);assert.equal(fw.motion.at(-1)?.parameters.dir,0);g.assertActive();
 // A transport lease is released here; physical stop/reset is still required
 // before a caller can change coordinates and emit replacement step commands.
}));

test('pressure window barrier submits a padded frontier without waiting for MCU clocks',async()=>fixture(async(d,g,c,q,_fw,end)=>{
 g.waitForMotionClocks=async()=>{throw new Error('physical clock wait must not run');};
 let delivered=0;
 const changes=[{stepper:'x',advance:.1,smoothTime:.2}];
 const pending=d.reconfigurePressureWindows(end,new Map([[q,[1,0,0] as const]]),changes,new AbortController().signal,3000,async horizon=>{delivered=horizon;});
 changes[0]!.smoothTime=.3;
 await assert.rejects(d.advanceSource(end,new AbortController().signal),/already active/);
 const result=await pending;
 assert.equal(result.generatedUntil,end+.1+.001);assert.equal(result.sourceUntil,result.generatedUntil+.1+.001);
 assert.equal(c.status.committedTime,result.generatedUntil);assert.equal(delivered,result.generatedUntil);assert.equal(g.status.state,'ready');
 q.appendRaw(new Float64Array([result.sourceUntil,0,.2,0,1,0,0,1,0,0,10,10,0,result.sourceUntil+.2,0,.3,0,3,0,0,0,0,0,0,0,0]));
 assert.equal(await d.advanceSource(result.sourceUntil+.5,new AbortController().signal,3000),true);assert.equal(c.status.failed,false);
},undefined,true));
test('invalid window settings reject before submitting or changing source padding',async()=>fixture(async(d,g,c,q,fw,end)=>{
 await assert.rejects(d.reconfigurePressureWindows(end,new Map([[q,[1,0,0] as const]]),[{stepper:'x',advance:.1,smoothTime:1e-200}],new AbortController().signal),/numeric/);
 assert.equal(c.status.generatedTime,0);assert.equal(fw.motion.length,0);assert.equal(g.status.state,'ready');
 await d.reconfigurePressureWindows(end,new Map([[q,[1,0,0] as const]]),[{stepper:'x',advance:0,smoothTime:.04}],new AbortController().signal,3000);
},undefined,true));

test('pressure barrier output failure stops the group after submitted generation',async()=>fixture(async(d,g,c,q,_fw,end)=>{
 const cause=new Error('output delivery failed');
 await assert.rejects(d.reconfigurePressureWindows(end,new Map([[q,[1,0,0] as const]]),[{stepper:'x',advance:.1,smoothTime:.2}],new AbortController().signal,3000,async()=>{throw cause;}),error=>error===cause);
 assert(c.status.committedTime>end);assert.equal(c.status.failed,true);assert.equal(g.status.state,'stopped');
},undefined,true));
