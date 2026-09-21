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
import {BedMesh} from '../src/motion/bed-mesh.ts';
import {BedMeshMovePort} from '../src/motion/bed-mesh-port.ts';
import {BedMeshProfileBinding} from '../src/motion/bed-mesh-profile-binding.ts';
import {GCodeMove} from '../src/gcode/move.ts';
import {motionLimits} from '../src/motion/lookahead.ts';
const mesh=(z:number)=>new BedMesh({min_x:0,max_x:20,min_y:0,max_y:20,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct',tension:.2},[[z,z],[z,z]]);
async function fixture(run:(f:{source:PlannedMotionSource;port:BedMeshMovePort;binding:BedMeshProfileBinding;gcode:GCodeMove;group:MCUGroup;fw:Awaited<ReturnType<typeof serialFirmware>>;xyz:TrapQueue;extrusion:TrapQueue})=>Promise<void>){
 const fw=await serialFirmware(),signal=new AbortController().signal;let session!:SerialSession;const group=new MCUGroup([{id:'m',async connect(s,stopDevice){session=new SerialSession(fw.fd,{stopDevice});await session.initialize(s);return session;},async stopDevice(){}}]);
 try{await group.start(signal);await session.configure({oidCount:5,commands:[]},signal);using xyz=new TrapQueue();using extrusion=new TrapQueue();const settings={frequency:1e6,timeOffset:0,maxError:0,queueStepTag:8,directionTag:9};using x=xyz.createStepper({...settings,oid:3},'x',.01);using e=extrusion.createStepper({...settings,oid:4},'extruder',.01);
 const sink=new MoveQueueSink([group.motionQueue('m',['x','e'],t=>x.clockAt(t))],async()=>{}),coordinator=new MotionCoordinator([{id:'x',queue:xyz,stepper:x},{id:'e',queue:extrusion,stepper:e}],sink,16*1024*1024,0,[session.clock]);
 const source=new PlannedMotionSource([{queue:xyz},{queue:extrusion,extrusionAxis:3}],new CoordinatedMotionDrain(coordinator,sink,group),Number(session.clock.sync.lastClock)/1e6+.1,[0,0,.1,0]);
 const port=new BedMeshMovePort({mesh:mesh(.1),physicalPosition:[0,0,.1,0],limits:motionLimits(300,3000),validate:()=>{}}),gcode=new GCodeMove(port),binding=new BedMeshProfileBinding(port,gcode,{},(moves,s)=>source.drain(moves,s));await run({source,port,binding,gcode,group,fw,xyz,extrusion});
 }finally{await group.stop();await fw.close();}
}
test('mesh activation drains earlier flushes and current XYZ/extrusion through real serial firmware',async()=>fixture(async f=>{
 f.gcode.execute('G1',{X:1,E:.1,F:600});f.source.append(f.port.flush());const prior=f.source.status.sourceTime;
 f.gcode.execute('G1',{X:2,E:.2});await f.binding.activate(mesh(.3),'new',new AbortController().signal);
 assert.deepEqual(f.source.status.position,[2,0,.1,.2]);assert.ok(f.source.status.sourceTime>prior);assert.equal(f.source.status.paused,true);assert.ok(Math.abs(f.gcode.state.position[2]+.2)<1e-15);assert.equal(f.port.currentMesh()!.calcZ(0,0),.3);
 const steps=(oid:number)=>f.fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===oid).reduce((n,m)=>n+Number(m.parameters.count),0);assert.equal(steps(3),200);assert.equal(steps(4),20);
 await f.binding.activate(mesh(.3),'same',new AbortController().signal);assert.equal(steps(3),200);assert.equal(steps(4),20);
 const next=Math.max(f.source.status.sourceTime,Number(f.group.session('m').clock.sync.lastClock)/1e6+.1);f.source.resumeAt(next);f.gcode.execute('G1',{X:3,E:.3});await f.source.drain(f.port.flush(),new AbortController().signal);assert.equal(steps(3),300);assert.equal(steps(4),30);assert.deepEqual(f.source.status.position,f.port.plannedPosition);assert.ok(Math.abs(f.source.status.position[2]-.1)<1e-15);
}));
test('late invalid trajectory rejects the whole source batch and stops downstream',async()=>fixture(async f=>{
 f.gcode.execute('G1',{X:1});const first=f.port.flush();f.gcode.execute('G1',{X:2});const second=f.port.flush();second[0].startPos[0]=7;
 assert.throws(()=>f.source.append([...first,...second]),/discontinuous/);await new Promise<void>(r=>setImmediate(r));assert.equal(f.source.status.failed,true);assert.equal(f.xyz.extract(10,0,1e10).length,0);assert.equal(f.extrusion.extract(10,0,1e10).length,0);assert.equal(f.fw.motion.length,0);assert.equal(f.group.status.state,'stopped');
}));
test('cancelled profile transition faults both source and admission and cannot resume',async()=>fixture(async f=>{
 f.gcode.execute('G1',{X:2,E:.2,F:600});const controller=new AbortController(),running=f.binding.activate(mesh(.3),'new',controller.signal);const rejected=assert.rejects(running);controller.abort(new Error('cancel source drain'));await rejected;assert.equal(f.source.status.failed,true);assert.ok(f.port.fault);assert.equal(f.group.status.state,'stopped');assert.throws(()=>f.source.resumeAt(100),/failed/);
}));
test('partial native append failure is terminal even before any packets have been submitted',async()=>fixture(async f=>{
 f.gcode.execute('G1',{X:1,E:.1});const planned=f.port.flush(),cause=new Error('extrusion queue allocation failure');let xyzAppends=0;const original=f.xyz.appendPlanned.bind(f.xyz);f.xyz.appendPlanned=(...args)=>{xyzAppends++;return original(...args);};f.extrusion.appendPlanned=()=>{throw cause;};
 await assert.rejects(f.source.drain(planned,new AbortController().signal),e=>e===cause);assert.equal(xyzAppends,1);assert.equal(f.source.status.failed,true);assert.deepEqual(f.source.status.position,[0,0,.1,0]);assert.equal(f.group.status.state,'stopped');assert.equal(f.fw.motion.length,0);assert.throws(()=>f.source.append(planned),/failed/);
}));
