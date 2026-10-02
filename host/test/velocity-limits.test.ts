import test from 'node:test';
import assert from 'node:assert/strict';
import {VelocityLimits,resolveVelocitySettings} from '../src/motion/velocity-limits.ts';
import {velocityUpdate,bindVelocityCommands} from '../src/gcode/velocity-limits.ts';
import {motionLimits} from '../src/motion/lookahead.ts';
import {BedMeshMovePort} from '../src/motion/bed-mesh-port.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {nativePrintFixture} from './helpers/native-linear-print.ts';
import {createNativeLinearPrint} from '../src/operations/native-linear-print.ts';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import {NativeLinearGCode} from '../src/runtime/native-linear-gcode.ts';
const signal=()=>new AbortController().signal;
test('M204 precedence, missing parameters and velocity ranges follow the Python contract',()=>{
 assert.deepEqual(velocityUpdate('M204',{S:'1200',P:'invalid',T:'invalid'}),{maxAccel:1200});assert.deepEqual(velocityUpdate('M204',{P:'200',T:'100'}),{maxAccel:100});assert.equal(velocityUpdate('M204',{P:'100'}),undefined);
 assert.deepEqual(velocityUpdate('SET_VELOCITY_LIMIT',{VELOCITY:'200',ACCEL:'3000',SQUARE_CORNER_VELOCITY:'0',MINIMUM_CRUISE_RATIO:'.9'}),{maxVelocity:200,maxAccel:3000,squareCornerVelocity:0,minCruiseRatio:.9});
 for(const p of ([{S:0},{S:-1},{S:Infinity},{P:100,T:'bad'}] as Record<string,string|number>[]))assert.throws(()=>velocityUpdate('M204',p));
 for(const p of ([{MINIMUM_CRUISE_RATIO:1},{SQUARE_CORNER_VELOCITY:-1},{VELOCITY:NaN},{ACCEL:0}] as Record<string,string|number>[]))assert.throws(()=>velocityUpdate('SET_VELOCITY_LIMIT',p));
});
test('limit publication is atomic and preserves exact configured cruise and corner inputs',()=>{
 const v=new VelocityLimits(motionLimits(100,1000,1.005,.123456789),{squareCornerVelocity:1.005,minCruiseRatio:.123456789}),before=v.state;
 assert.throws(()=>v.update({maxAccel:200},()=>{throw new Error('admission');}));assert.deepEqual(v.state,before);
 for(const patch of [{maxAccel:0},{maxVelocity:1e308},{squareCornerVelocity:1e308},{minCruiseRatio:1}])assert.throws(()=>v.update(patch,()=>{throw new Error('must not accept');}));assert.deepEqual(v.state,before);
 v.update({maxAccel:200},limits=>assert.deepEqual(limits,motionLimits(100,200,1.005,.123456789)));assert.equal(v.state.squareCornerVelocity,1.005);assert.equal(v.state.minCruiseRatio,.123456789);
 const copy=v.state;copy.maxAccel=999;assert.equal(v.state.maxAccel,200);
});
test('changing future mesh limits retains queued profiles, boundary markers and extrusion junction owner',()=>{
 let junctions=0;const limits=motionLimits(100,1000),port=new BedMeshMovePort({mesh:null,physicalPosition:[0,0,0,0],limits:{...limits,extraAxes:[()=>{junctions++;return 10000;}]},validate:()=>{}});
 port.move([1,0,0,0],100);port.markPendingBoundary(7);port.setMotionLimits(motionLimits(20,200,2,.7));assert.equal(port.pending,1);port.move([2,0,0,0],100);const moves=port.flush();assert.equal(moves.length,2);assert.equal(moves[0].accel,1000);assert.equal(moves[1].accel,200);assert.equal(moves[1].maxCruiseV2,400);assert.deepEqual(moves[0].endMarkers,[7]);assert.notEqual(moves[0].limits,moves[1].limits);assert(moves[0].profile!.endV>0);assert.equal(junctions,1);
});
test('velocity query reports fixed decimals and invalid multi-field commands leave state unchanged',async()=>{
 const v=new VelocityLimits(motionLimits(100,1000)),reports:string[]=[],d=new GCodeDispatch({output:m=>reports.push(m),shutdown:()=>{}});bindVelocityCommands(d,{get velocitySettings(){return v.state;},updateVelocityLimits:p=>v.update(p,()=>{})});d.setReady(true);
 await d.execute('M204 S200\nSET_VELOCITY_LIMIT');assert(reports.join('\n').includes('max_accel: 200.000000'));assert(reports.join('\n').includes('minimum_cruise_ratio: 0.500000'));
 const before=v.state;await assert.rejects(d.execute('SET_VELOCITY_LIMIT VELOCITY=10 ACCEL=-1'));await assert.rejects(d.execute('SET_VELOCITY_LIMIT VELOCITY=1e308'));assert.deepEqual(v.state,before);await d.execute('M204 P10');assert.deepEqual(v.state,before);assert(reports.at(-1)!.includes('Invalid M204'));
});
test('native file mixes velocity commands, linear and arc motion without losing its exact endpoint',async()=>{
 const f=await nativePrintFixture('G1 X50.2 F600\nM204 S100\nG1 X50.4\nSET_VELOCITY_LIMIT VELOCITY=50 ACCEL=500 SQUARE_CORNER_VELOCITY=1 MINIMUM_CRUISE_RATIO=0.2\nG2 X51.4 I0.5 E2.01\n'),owner=await createNativeLinearPrint(f.options),eof=Promise.withResolvers<void>();owner.device.subscribeEOF(()=>eof.resolve());owner.device.subscribeFault(eof.reject);void eof.promise.catch(()=>{});
 try{await owner.device.prepare({version:1,requestId:'limits',fileId:'file',nozzle:200,bed:60},signal());await owner.device.start('file',signal());await eof.promise;await owner.device.finish('limits',signal());assert.deepEqual(f.t.port.velocityStatus,{max_velocity:50,max_accel:500,square_corner_velocity:1,minimum_cruise_ratio:.2});assert.deepEqual(f.gcode.coordinates.state.position,[51.4,0,0,2.01]);assert.equal(f.t.generation.motion.bindings.find(b=>b.id==='x')!.history.status.lastPlannedPosition,240n);assert.equal(f.outputStops,0);}finally{await owner.close();await f.close();}
});
test('dynamic ceilings reach homing planning and survive native generation replacement without granting homing',async()=>{
 const f=await nativeLinearFixture();try{f.port.updateVelocityLimits({maxVelocity:2,maxAccel:50});assert.equal(f.kinematics.status.homedAxes,'');const homing=f.kinematics.planHomingAxisMove([50,0,0,2],[51,0,0,2],10,0);assert.equal(homing.maxCruiseV2,4);assert.equal(homing.accel,50);await f.port.forcePosition([50,0,0,2],signal());assert.equal(f.port.velocitySettings.maxAccel,50);assert.equal(f.kinematics.status.homedAxes,'');assert.throws(()=>f.port.move([51,0,0,2],10),/home/);f.kinematics.markHomed([0,1,2]);assert.throws(()=>f.port.move([50,0,0,3],10),/temperature/);assert.equal(f.port.status.pendingMoves,0);}finally{await f.close();}
});
test('refusing a paused limit update is a command error and does not retire the native printer',async()=>{
 const f=await nativeLinearFixture(),reports:string[]=[];let gcode:NativeLinearGCode|undefined;
 try{gcode=new NativeLinearGCode(f.port,f.kinematics,[51,0,0].map(endstop=>({endstop,positiveDirection:false,speed:10,retractDistance:0,retractSpeed:10,secondSpeed:5,endstops:['test']})),m=>reports.push(m));gcode.enable();await f.port.pause(signal());await assert.rejects(gcode.dispatch.execute('M204 S200'),/busy or paused/);assert.equal(f.port.status.failed,false);assert.equal(f.port.velocityStatus.max_accel,1000);await f.port.resumeStream(signal());await gcode.dispatch.execute('SET_VELOCITY_LIMIT');assert(reports.some(r=>r.includes('max_accel: 1000.000000')));await gcode.dispatch.execute('M204 S200');assert.equal(f.port.velocitySettings.maxAccel,200);assert.equal(f.f.stops,0);}finally{await gcode?.close();await f.close();}
});
