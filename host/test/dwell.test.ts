import test from 'node:test';
import assert from 'node:assert/strict';
import {dwellMove,replanWithDwells,validateDwell} from '../src/motion/dwell.ts';
import {motionLimits,LookAheadQueue,Move} from '../src/motion/lookahead.ts';
import {planPathStop,validateStopPath} from '../src/motion/path-stop.ts';
import {nativePrintFixture} from './helpers/native-linear-print.ts';
import {createNativeLinearPrint} from '../src/operations/native-linear-print.ts';
import {idleMotionFixture,idleTestMove} from './helpers/idle-motion.ts';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
const limits=motionLimits(100,100),signal=()=>new AbortController().signal;
function moving(a:number,b:number){const q=new LookAheadQueue();q.add(new Move(limits,[a,0,0,0],[b,0,0,0],10));return q.flush();}
test('retained planning accepts the full move capacity without spread arguments and rejects invalid batches',()=>{
 const moves=Array.from({length:100000},(_,i)=>new Move(limits,[i,0,0,0],[i+1,0,0,0],10)),planned=replanWithDwells(moves);
 assert.equal(planned.length,100000);assert.equal(planned[0].profile!.startV,0);assert.equal(planned.at(-1)!.profile!.endV,0);assert.deepEqual(planned.at(-1)!.endPos,[100000,0,0,0]);validateStopPath(planned);
 assert.throws(()=>replanWithDwells([...moves,moves[0]]),/Invalid retained motion batch/);assert.throws(()=>replanWithDwells([moves[0],moves[0]]),/Duplicate/);
});
test('stationary intervals survive stop planning and resume without altering geometry or remaining duration',()=>{
 const before=moving(0,1),dwell=dwellMove(limits,[1,0,0,0],1.5),after=moving(1,2),path=[...before,dwell,...after];validateStopPath(path);
 const p=before[0].profile!,time=p.accelT+p.cruiseT+p.decelT,stop=planPathStop(path,time+.25);assert.deepEqual(stop.position,[1,0,0,0]);assert.equal(stop.velocity,0);assert.equal(stop.brake.length,0);assert.equal(stop.remainder[0].dwellSeconds,1.25);
 const resumed=replanWithDwells(stop.remainder);validateStopPath(resumed);assert.equal(resumed[0].profile!.cruiseT,1.25);assert.equal(resumed[1].profile!.startV,0);assert.deepEqual(resumed.at(-1)!.endPos,[2,0,0,0]);
 const braking=planPathStop(path,.025);assert(braking.remainder.some(m=>m.dwellSeconds===1.5));const queue=new LookAheadQueue();assert.throws(()=>queue.add(dwell),/explicit stop/);assert.throws(()=>queue.addBatch([dwell]));
 for(const seconds of [0,-1,NaN,Infinity,3601])assert.throws(()=>dwellMove(limits,[0,0,0,0],seconds));const invalid=dwellMove(limits,[0,0,0,0],1);invalid.endPos[0]=1;assert.throws(()=>validateDwell(invalid));
});
test('native G4 is a paced trajectory checkpoint that can pause and resume without losing its file suffix',async()=>{
 const f=await nativePrintFixture('G4 P1500\nG1 X51 E2.01 F600\n'),owner=await createNativeLinearPrint(f.options),eof=Promise.withResolvers<void>();owner.device.subscribeEOF(()=>eof.resolve());owner.device.subscribeFault(cause=>eof.reject(cause));void eof.promise.catch(()=>{});
 try{
  await owner.device.prepare({version:1,requestId:'dwell',fileId:'file',nozzle:200,bed:60},signal());await owner.device.start('file',signal());
  const end=performance.now()+3000;while(!f.t.generation.source.status.bufferedMoves){assert(performance.now()<end);await new Promise(resolve=>setTimeout(resolve,2));}
  await owner.device.pause(signal());assert.equal(owner.file.status.file?.checkpointHeld,true);assert.deepEqual(f.t.port.position(),[50,0,0,2]);assert.equal(f.t.port.status.failed,false);assert.equal(owner.file.status.file?.position,0);
  const pausedAt=performance.now();await owner.device.resume(signal());await eof.promise;await owner.device.finish('dwell',signal());assert(performance.now()-pausedAt>500);assert.deepEqual(f.gcode.coordinates.state.position,[51,0,0,2.01]);assert.equal(f.t.generation.motion.bindings.find(b=>b.id==='x')!.history.status.lastPlannedPosition,200n);assert.equal(f.outputStops,0);
 }finally{await owner.close();await f.close();}
});
test('cancelling a dwell retires the held file without admitting its following movement',async()=>{
 const f=await nativePrintFixture('G4 P3000\nG1 X51 E2.01 F600\n'),owner=await createNativeLinearPrint(f.options);
 try{await owner.device.prepare({version:1,requestId:'cancel',fileId:'file',nozzle:200,bed:60},signal());await owner.device.start('file',signal());const end=performance.now()+3000;while(!f.t.generation.source.status.bufferedMoves){assert(performance.now()<end);await new Promise(resolve=>setTimeout(resolve,2));}await owner.device.stop();assert.equal(owner.file.status.file?.closed,true);assert.deepEqual(f.gcode.coordinates.state.position,[50,0,0,2]);assert.equal(f.t.f.fw.motion.filter(m=>m.name==='queue_step').length,0);assert.equal(f.outputFinishes,0);}finally{await owner.close();await f.close();}
});
test('G4 follows P milliseconds, ignores S and rejects invalid duration before movement',async()=>{
 const f=await nativePrintFixture();try{f.gcode.enable();await f.gcode.dispatch.execute('G4 P0\nG4 S300');assert.equal(f.t.generation.source.status.seeded,false);assert.equal(f.t.f.fw.motion.length,0);await assert.rejects(f.gcode.dispatch.execute('G4 P-1\nG1 X51'),/Invalid G4 P/);assert.equal(f.t.f.fw.motion.length,0);}finally{await f.close();}
});
test('dwell source refuses a nonzero junction velocity and preserves exact stationary endpoints',async()=>{
 const f=idleMotionFixture(true);try{f.source.startAt(1);const moves=idleTestMove();f.source.append(moves);const start=f.source.status.sourceTime;f.source.append([dwellMove(limits,f.source.status.position,.125)]);assert.equal(f.source.status.sourceTime,start+.125);await f.source.drain([],signal());assert.deepEqual(f.positions,{x:200n,e:30n});assert.equal(f.stops,0);}finally{f.close();}
 const broken=idleMotionFixture();try{broken.source.startAt(1);const moves=idleTestMove();moves[0].profile!.endV=1;assert.throws(()=>broken.source.append([...moves,dwellMove(limits,moves[0].endPos,.1)]),/begin at rest/);assert.equal(broken.commits,0);}finally{broken.close();}
});
test('long native dwell maintains shared MCU calibration without granting homing or producing steps',async()=>{
 const f=await nativeLinearFixture(0,()=>true,true,undefined,false,true,true);try{
  const timeline=f.generation.clockTimelines!.find(c=>c.id==='m')!.timeline,start=timeline.status.latestClock;await f.port.dwell(5,signal());await f.port.drain(signal());
  assert(timeline.status.latestClock-start>3000000n);assert.equal(f.kinematics.status.homedAxes,'');assert.equal(f.f.fw.motion.filter(m=>m.name==='queue_step').length,0);assert.deepEqual(f.port.position(),[50,0,0,2]);assert.equal(f.f.stops,0);
 }finally{await f.close();}
});
