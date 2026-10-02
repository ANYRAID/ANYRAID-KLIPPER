import test from 'node:test';
import assert from 'node:assert/strict';
import {GCodeArcs,planArc,arcSegment} from '../src/gcode/arcs.ts';
import {GCodeMove} from '../src/gcode/move.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {readArcResolution} from '../src/config/arcs.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {nativePrintFixture} from './helpers/native-linear-print.ts';
import {createNativeLinearPrint} from '../src/operations/native-linear-print.ts';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import {NativeLinearGCode} from '../src/runtime/native-linear-gcode.ts';
const signal=()=>new AbortController().signal;
test('arc planes, helices, full circles and exact endpoint preserve the linear coordinate contract',()=>{
 for(const plane of [0,1,2] as const)for(const clockwise of [false,true]){
  const params:Record<string,number>=plane===0?{I:10,Z:3}:plane===1?{I:10,Y:3}:{J:10,X:3},p=planArc([0,0,0,2],true,{...params,E:3,F:600},clockwise,plane,.25);
  assert(p.segments>250);assert.deepEqual(Array.from(p.points.slice(-4,-1)),plane===0?[0,0,3]:plane===1?[0,3,0]:[3,0,0]);assert(Math.abs(p.points.at(-1)!-3)<1e-12);assert.equal(arcSegment(p,0).F,600);
 }
 const short=planArc([0,0,0,2],false,{X:.001,I:.0005,E:.25},true);assert.equal(short.segments,1);assert.deepEqual(arcSegment(short,0),{X:.001,Y:0,Z:0,E:.25});
});
test('arc input and capacity failures have no geometry admission',async()=>{
 let count=0;const coordinate=new GCodeMove({position:()=>[0,0,0,0],move:()=>{count++;}}),dispatch=new GCodeDispatch({output:()=>{},shutdown:()=>{}});new GCodeArcs().register(dispatch,coordinate,async()=>{});dispatch.setReady(true);
 for(const command of ['G2 X1','G3 I1 R1','G2 I1 F0','G2 I1 F-1','G3 I'+'9'.repeat(309),'G2 I1000000'])await assert.rejects(dispatch.execute(command),command);
 coordinate.execute('G91');await assert.rejects(dispatch.execute('G2 I1'),/relative/);assert.equal(count,0);
 assert.throws(()=>new GCodeArcs(0));assert.throws(()=>planArc([0,0,0,0],true,{I:1},false,0,Number.MIN_VALUE),/capacity/);
});
test('arc dispatch preserves extrusion and speed overrides, plane modality and rolling checkpoints',async()=>{
 let position=[0,0,0,2],flushes=0;const moves:number[][]=[],coordinates=new GCodeMove({position:()=>position,move:p=>{position=[...p];moves.push(position);}}),dispatch=new GCodeDispatch({output:()=>{},shutdown:()=>{}}),arcs=new GCodeArcs(.1);arcs.register(dispatch,coordinates,async()=>{flushes++;});dispatch.setReady(true);
 coordinates.execute('G92',{X:10,E:0});coordinates.execute('M221',{S:200});coordinates.execute('M220',{S:50});coordinates.execute('M83');
 await dispatch.execute('G18\nG2 I10 Y3 E1 F600');assert.equal(arcs.plane,1);assert.deepEqual(position.slice(0,3),[0,3,0]);assert(Math.abs(position[3]-4)<1e-11);assert.equal(coordinates.state.speed,5);assert(flushes>=5);assert(moves.length>600);
});
test('arc resolution configuration defaults, overrides and invalid values',()=>{
 const read=(sections:Record<string,Record<string,string>>)=>readArcResolution(new ConfigurationReader(new ConfigurationSource('/arc.cfg',sections,[]),null));
 assert.equal(read({}),1);assert.equal(read({gcode_arcs:{}}),1);assert.equal(read({gcode_arcs:{resolution:'.25'}}),.25);for(const resolution of ['0','-1','nan','inf'])assert.throws(()=>read({gcode_arcs:{resolution}}));
});
test('native arc file pauses within a rolling checkpoint, resumes and completes its exact suffix',async()=>{
 const f=await nativePrintFixture('G2 J1 E2.01 F120\nG1 X51 E2.02\nSET_PRINT_STATS_INFO TOTAL_LAYER=1 CURRENT_LAYER=1\n',false,false,false,.025),owner=await createNativeLinearPrint(f.options),eof=Promise.withResolvers<void>();owner.device.subscribeEOF(()=>eof.resolve());owner.device.subscribeFault(eof.reject);void eof.promise.catch(()=>{});
 try{
  await owner.device.prepare({version:1,requestId:'arc',fileId:'file',nozzle:200,bed:60},signal());await owner.device.start('file',signal());
  const deadline=performance.now()+3000;while(!f.t.generation.source.status.bufferedMoves){assert(performance.now()<deadline);await new Promise(r=>setTimeout(r,2));}
  await owner.device.pause(signal());assert.equal(owner.file.status.file?.checkpointHeld,true);assert.equal(owner.file.status.file?.position,0);assert.equal(f.gcode.layers.status.total_layer,null);
  await owner.device.resume(signal());await eof.promise;await owner.device.finish('arc',signal());assert.deepEqual(f.gcode.coordinates.state.position.slice(0,3),[51,0,0]);assert(Math.abs(f.gcode.coordinates.state.position[3]-2.02)<1e-12);assert.equal(f.t.generation.motion.bindings.find(b=>b.id==='x')!.history.status.lastPlannedPosition,200n);assert.equal(f.gcode.layers.status.current_layer,1);assert.equal(f.outputStops,0);
 }finally{await owner.close();await f.close();}
});
test('cancelling a native arc cannot execute its trailing file commands',async()=>{
 const f=await nativePrintFixture('G2 J1 F120\nSET_PRINT_STATS_INFO TOTAL_LAYER=1\n',false,false,false,.025),owner=await createNativeLinearPrint(f.options);
 try{await owner.device.prepare({version:1,requestId:'arc-cancel',fileId:'file',nozzle:200,bed:60},signal());await owner.device.start('file',signal());const deadline=performance.now()+3000;while(!f.t.generation.source.status.bufferedMoves){assert(performance.now()<deadline);await new Promise(r=>setTimeout(r,2));}await owner.device.stop();assert.equal(f.gcode.layers.status.total_layer,null);assert.equal(owner.file.status.file?.closed,true);assert.equal(f.outputFinishes,0);}finally{await owner.close();await f.close();}
});
test('native arcs retain homing and cold extrusion guards before emitting any steps',async()=>{
 for(const homed of [false,true]){
  const f=await nativeLinearFixture(),gcode=new NativeLinearGCode(f.port,f.kinematics,[51,0,0].map(endstop=>({endstop,positiveDirection:false,speed:10,retractDistance:0,retractSpeed:10,secondSpeed:5,endstops:['test']})),()=>{});
  try{if(homed)f.kinematics.markHomed([0,1,2]);gcode.enable();await assert.rejects(gcode.dispatch.execute(homed?'G2 J1 E2.01':'G2 J1'));assert.equal(f.f.fw.motion.filter(m=>m.name==='queue_step').length,0);assert.deepEqual(gcode.coordinates.state.position,[50,0,0,2]);assert.equal(f.port.status.failed,true);}finally{await gcode.close();await f.close();}
 }
});

test('all frozen original Python arc coordinates match without invoking Python',async()=>{
 const {arcsReference:{origin,cases,reference}}=await import('./helpers/arcs-reference.ts');
 assert.equal(cases.length,80);assert.equal(reference.results.length,cases.length);
 for(const [i,c] of cases.entries()){
  const plan=planArc(origin,c.absolute,c.params,c.clockwise,c.plane,c.resolution),expected=reference.results[i];assert.equal(plan.segments,expected.length);
  for(const [j,point] of expected.entries()){const actual=arcSegment(plan,j);assert.deepEqual(Object.keys(actual).sort(),Object.keys(point).sort());for(const key of Object.keys(point))assert(Math.abs(Number(actual[key])-point[key])<=1e-12*Math.max(1,Math.abs(point[key])));}
 }
});
