import test from 'node:test';
import assert from 'node:assert/strict';
import {MCUGroup} from '../src/runtime/mcu-group.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
import {MoveQueueSink} from '../src/motion/move-queue-sink.ts';
import {CoordinatedMotionDrain} from '../src/motion/coordinated-drain.ts';
import {PlannedMotionSource} from '../src/motion/planned-motion-source.ts';
import {Move,motionLimits} from '../src/motion/lookahead.ts';
for(const mode of ['normal','brake','failure'])test(`independent Z retains stationary motor through drain and resume mode=${mode}`,async()=>{
 const fw=await serialFirmware(),signal=new AbortController().signal;let session!:SerialSession;
 const group=new MCUGroup([{id:'m',async connect(s,stopDevice){session=new SerialSession(fw.fd,{stopDevice});await session.initialize(s);return session;},async stopDevice(){}}]);
 try{
  await group.start(signal);await session.configure({oidCount:6,commands:[]},signal);
  using xyz=new TrapQueue();using extrusion=new TrapQueue();using fixed=new TrapQueue();
  const settings={frequency:1e6,timeOffset:0,maxError:0,queueStepTag:8,directionTag:9};
  using z=xyz.createStepper({...settings,oid:3},'z',.01);using e=extrusion.createStepper({...settings,oid:4},'extruder',.01);
  fixed.setPosition(0,0,0,7);using z1=fixed.createStepper({...settings,oid:5},'z',.01,[0,0,7]);
  const sink=new MoveQueueSink([group.motionQueue('m',['z','e','z1'],t=>z.clockAt(t))],async()=>{});
  const coordinator=new MotionCoordinator([{id:'z',queue:xyz,stepper:z},{id:'e',queue:extrusion,stepper:e},{id:'z1',queue:fixed,stepper:z1}],sink,16*1024*1024,0,[session.clock]);
  const drain=new CoordinatedMotionDrain(coordinator,sink,group),position:[number,number,number]=[0,0,7],routes=[{queue:xyz},{queue:extrusion,extrusionAxis:3},{queue:fixed,stationaryPosition:position}];
  assert.throws(()=>new PlannedMotionSource([...routes.slice(0,2),{queue:fixed,stationaryPosition:[0,0,NaN]}],drain,1,[0,0,0,0]),/stationary/);
  assert.throws(()=>new PlannedMotionSource([...routes.slice(0,2),{queue:fixed,stationaryPosition:position,extrusionAxis:3}],drain,1,[0,0,0,0]),/stationary/);
  const start=Number(session.clock.sync.lastClock)/1e6+.1,source=new PlannedMotionSource(routes,drain,start,[0,0,0,0]);position[2]=99;
  if(mode==='failure'){fixed.appendRaw=()=>{throw new Error('stationary queue failure');};}
  const move=new Move(motionLimits(100,1000),[0,0,0,0],[0,0,1,0],10);move.setJunction(0,100,0);
  if(mode==='failure'){await assert.rejects(source.drain([move],signal),/stationary queue failure/);assert.equal(source.status.failed,true);assert.equal(group.status.state,'stopped');assert.equal(fw.motion.length,0);return;}
  source.append([move]);
  if(mode==='brake')await source.brakeAt(start+.03,signal);
  await source.drain([],signal);
  const steps=(oid:number)=>fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===oid).reduce((n,m)=>n+Number(m.parameters.count),0);
  assert.equal(steps(5),0);assert.equal(steps(4),0);assert.ok(steps(3)>0);if(mode==='normal')assert.equal(steps(3),100);
  const p=source.status.position,next=[...p];next[2]+=.5;const resume=new Move(motionLimits(100,1000),p,next,10);resume.setJunction(0,100,0);
  source.resumeAt(Math.max(source.status.sourceTime,Number(session.clock.sync.lastClock)/1e6+.1));const before=steps(3);await source.drain([resume],signal);
  assert.equal(steps(3)-before,50);assert.equal(steps(5),0);assert.equal(source.status.paused,true);assert.equal(group.status.state,'ready');
 }finally{await group.stop();await fw.close();}
});
