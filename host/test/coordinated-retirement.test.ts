import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
import {MoveQueueSink,type ScheduledTransport} from '../src/motion/move-queue-sink.ts';
import {MotionRetiredError} from '../src/motion/retired.ts';
const signal=()=>new AbortController().signal;
function barrier(){let resolve!:()=>void,reject!:(e:unknown)=>void;const promise=new Promise<void>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function fixture(history:()=>Promise<void>,transports:ScheduledTransport[]){
 const q=new TrapQueue();q.appendRaw(new Float64Array([1,0,1,0,0,0,0,1,1,0,10,10,0]));
 const steppers=transports.map((_,i)=>q.createStepper({frequency:1e6,timeOffset:0,oid:i,maxError:0,queueStepTag:5,directionTag:6},i?'y':'x',.01));
 const sink=new MoveQueueSink(transports.map((transport,i)=>({id:`m${i}`,emitters:[`s${i}`],moveSlots:512,clockAt:(t:number)=>BigInt(Math.round(t*1e6)),transport})),history);
 const c=new MotionCoordinator(steppers.map((stepper,i)=>({id:`s${i}`,queue:q,stepper})),sink);
 return {q,steppers,sink,c,[Symbol.dispose](){for(const s of steppers)s.dispose();q.dispose();}};
}
test('retirement fences all MCU routes synchronously and waits for retained history and coordinator idle',async()=>{
 const held=barrier();let sent=0,stops=0,retired=0;
 const transport=()=>({async send(){sent++;},async stop(){stops++;},async retire(){retired++;}});
 using f=fixture(()=>held.promise,[transport(),transport()]);const advance=f.c.advance(1.5),rejected=assert.rejects(advance,MotionRetiredError);
 const retirement=f.c.retire(signal());assert.equal(retired,2);assert.strictEqual(f.c.retire(signal()),retirement);assert.equal(f.c.status.retired,true);
 let complete=false;void retirement.then(()=>{complete=true;});await Promise.resolve();await Promise.resolve();assert.equal(complete,false);
 await assert.rejects(f.c.advance(1.6),MotionRetiredError);held.resolve();await rejected;await retirement;
 assert.equal(f.c.status.busy,false);assert.equal(f.c.status.failed,false);assert.equal(f.c.status.committedTime,0);assert.equal(sent,0);assert.equal(stops,0);
});
test('retirement cancels a current sender and prevents later MCU sends and bounded windows',async()=>{
 const sending=barrier(),started=barrier();let second=0,stops=0;
 using f=fixture(async()=>{},[{send(){started.resolve();return sending.promise;},async stop(){stops++;},async retire(){sending.reject(new MotionRetiredError());}},{async send(){second++;},async stop(){stops++;},async retire(){}}]);
 const advance=f.c.advanceBounded(1.9),rejected=assert.rejects(advance,MotionRetiredError);await started.promise;await f.c.retire(signal());await rejected;
 assert.equal(second,0);assert.equal(stops,0);assert.equal(f.c.status.busy,false);assert.equal(f.c.status.failed,false);assert(f.c.status.generatedTime<1.9);
});
test('a history fault racing retirement fails the group rather than being hidden as cancellation',async()=>{
 const held=barrier();let stops=0;
 using f=fixture(()=>held.promise,[{async send(){assert.fail();},async stop(){stops++;},async retire(){}}]);
 const advancing=f.c.advance(1.5),badAdvance=assert.rejects(advancing,/disk failure/),retiring=f.c.retire(signal()),badRetire=assert.rejects(retiring,/disk failure/);
 held.reject(new Error('disk failure'));await Promise.all([badAdvance,badRetire]);assert.equal(stops,1);assert.equal(f.c.status.failed,true);
});
test('one retirement failure stops every member even if another fails synchronously',async()=>{
 let stops=0,retirements=0;
 using f=fixture(async()=>{},[0,1].map(()=>({async send(){},async stop(){stops++;},retire(){retirements++;throw new Error('delivery failure');}})));
 await assert.rejects(f.c.retire(signal()),/delivery failure/);assert.equal(retirements,2);assert.equal(stops,2);assert.equal(f.c.status.failed,true);
});
test('cancelling an unresponsive history wait stops devices and late completion cannot send',async()=>{
 const held=barrier();let stops=0,sent=0;using f=fixture(()=>held.promise,[{async send(){sent++;},async stop(){stops++;},async retire(){}}]);
 const pending=f.c.advance(1.5),failed=assert.rejects(pending),abort=new AbortController(),retiring=f.c.retire(abort.signal),cancelled=assert.rejects(retiring,/cancelled/);
 abort.abort(new Error('cancelled'));await cancelled;assert.equal(stops,1);assert.equal(f.c.status.failed,true);held.resolve();await failed;assert.equal(sent,0);
});
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
test('coordinator retires two real native serial routes after their generated command prefixes arrive',async()=>{
 const firmware:Awaited<ReturnType<typeof serialFirmware>>[]=[],sessions:SerialSession[]=[];let stops=0;
 try{
  for(let i=0;i<2;i++){const fw=await serialFirmware();firmware.push(fw);const s=new SerialSession(fw.fd,{async stopDevice(){stops++;}});sessions.push(s);await s.initialize(signal());await s.configure({oidCount:4,commands:[]},signal());}
  using q=new TrapQueue();q.appendRaw(new Float64Array([1.8,0,.1,0,0,0,0,1,1,0,10,10,0]));
  const steppers=sessions.map((s,i)=>q.createStepper({frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:s.dictionary.lookup('queue_step oid=%c interval=%u count=%hu add=%hi').id,directionTag:s.dictionary.lookup('set_next_step_dir oid=%c dir=%c').id},i?'y':'x',.01));
  try{
   const sink=new MoveQueueSink(sessions.map((s,i)=>s.motionQueue(`m${i}`,[`s${i}`],t=>steppers[i].clockAt(t))),async()=>{});
   const coordinator=new MotionCoordinator(steppers.map((stepper,i)=>({id:`s${i}`,queue:q,stepper})),sink,16*1024*1024,0,sessions);
   await coordinator.advance(1.9);await coordinator.retire(signal());
   assert.equal(stops,0);assert.equal(coordinator.status.busy,false);assert.equal(coordinator.status.failed,false);
   for(let i=0;i<2;i++){assert.equal(sessions[i].status.pendingAcks,0);assert.equal(firmware[i].motion.filter(m=>m.name==='queue_step').reduce((total,m)=>total+Number(m.parameters.count),0),100);await sessions[i].motionTransport([`s${i}`]).retire(signal());}
  }finally{for(const stepper of steppers)stepper.dispose();}
 }finally{for(const s of sessions)await s.stop();for(const fw of firmware)await fw.close();}
});
