import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {MCUGroup} from '../src/runtime/mcu-group.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialFirmware} from '../test/helpers/serial-firmware.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
import {MoveQueueSink} from '../src/motion/move-queue-sink.ts';
import {CoordinatedMotionDrain} from '../src/motion/coordinated-drain.ts';
const times:number[]=[];
for(let i=0;i<16;i++){const fw=await serialFirmware(),signal=new AbortController().signal;let s!:SerialSession;const group=new MCUGroup([{id:'m',async connect(signal,stopDevice){s=new SerialSession(fw.fd,{stopDevice});await s.initialize(signal);return s;},async stopDevice(){}}]);try{await group.start(signal);await s.configure({oidCount:4,commands:[]},signal);const start=Number(s.clock.sync.lastClock)/1e6+.1,end=start+.1;using q=new TrapQueue();q.appendRaw(new Float64Array([start,0,.1,0,0,0,0,1,0,0,10,10,0]));using step=q.createStepper({frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:8,directionTag:9},'x',.01);const sink=new MoveQueueSink([group.motionQueue('m',['x'],t=>step.clockAt(t))],async()=>{}),c=new MotionCoordinator([{id:'x',queue:q,stepper:step}],sink,16*1024*1024,0,[s.clock]),drain=new CoordinatedMotionDrain(c,sink,group);const begin=performance.now(),result=await drain.drain(end,new Map([[q,[1,0,0] as const]]),signal,3000),elapsed=performance.now()-begin;assert.ok(s.clock.sync.lastClock>result.targets.m);assert.equal(fw.motion.filter(m=>m.name==='queue_step').reduce((sum,m)=>sum+Number(m.parameters.count),0),100);if(i>=5)times.push(elapsed);}finally{await group.stop();await fw.close();}}
times.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,runs:16,warmups:5,medianMs:times[5],p95Ms:times[10],scope:'Native generation, real sink/serial ACK and future sampled-clock wait against Unix-stream firmware emulator. Initialization excluded. Sampling period dominates latency; not hardware motion completion or CPU-only overhead.'},null,2));
