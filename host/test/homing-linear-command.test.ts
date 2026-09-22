import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {LinearHomingCommand,HomingCommandError,homingRetract} from '../src/homing/linear-command.ts';
import {linearHomingFixture,homingPass} from './helpers/linear-homing.ts';
const signal=()=>new AbortController().signal;
test('G28 X0 runs seek/retract/second seek before publishing homed axes and G-code offsets',async()=>{
 const f=linearHomingFixture(),output:string[]=[];const dispatch=new GCodeDispatch({output:s=>output.push(s),shutdown:()=>assert.fail('unexpected shutdown')});f.command.register(dispatch);dispatch.setReady(true);
 f.coordinates.execute('SET_GCODE_OFFSET',{X:.5});f.coordinates.execute('G92',{Y:5});
 await dispatch.execute('G28 X0',{acknowledge:true});
 assert.equal(f.kin.status.homedAxes,'x');assert.deepEqual(f.events.filter(e=>e.kind==='home').map(e=>[e.position[0],e.speed]),[[0,40],[0,10]]);
 assert.deepEqual(f.events.filter(e=>e.kind==='force').map(e=>e.position),[[300,35,40,7],[10,35,40,7]]);assert.equal(f.events.find(e=>e.kind==='retract')!.position[0],5);
 assert.deepEqual(f.coordinates.state.position,[.02,35,40,7]);assert.equal(f.coordinates.state.base[0],.5);assert.equal(f.coordinates.state.base[1],30);assert.deepEqual(output,['ok']);assert.equal(f.stops,0);
});
test('unqualified G28 homes XYZ and explicit axes follow kinematic order',async()=>{
 for(const [line,wanted] of [['G28','xyz'],['G28 Z X','xz']]){
  const f=linearHomingFixture({retractDistance:0}),d=new GCodeDispatch({output(){},shutdown:()=>assert.fail()});f.command.register(d);d.setReady(true);await d.execute(line);
  assert.equal(f.kin.status.homedAxes,wanted);assert.deepEqual(f.events.filter(e=>e.kind==='home').map(e=>'xyz'[e.axis!]).join(''),wanted);assert.equal(f.port.position()[3],7);assert(!f.events.some(e=>e.kind==='retract'));
 }
});
test('no trigger and stuck second trigger report named errors and revoke every axis',async()=>{
 for(const mode of ['miss','stuck'] as const){
  const f=linearHomingFixture({pass:async attempt=>homingPass(mode==='miss'||attempt===2?mode:'hit')});f.kin.markHomed([0,1,2]);
  await assert.rejects(f.command.home([0],signal()),e=>e instanceof HomingCommandError&&e.code===(mode==='miss'?'no_trigger':'still_triggered')&&e.endstop==='stepper_x');
  assert.equal(f.kin.status.homedAxes,'');assert.equal(f.stops,1);assert.deepEqual(f.coordinates.state.position,f.port.position());assert.equal(f.events.filter(e=>e.kind==='home').length,mode==='miss'?1:2);
 }
});
test('cancellation of a pending homing pass stops motors and late completion cannot grant authority',async()=>{
 let entered!:()=>void,release!:(p:ReturnType<typeof homingPass>)=>void;const ready=new Promise<void>(r=>{entered=r;}),held=new Promise<ReturnType<typeof homingPass>>(r=>{release=r;});
 const f=linearHomingFixture({pass:async()=>{entered();return held;}}),abort=new AbortController();const running=f.command.home([0],abort.signal),failed=assert.rejects(running,/cancel home/);
 await ready;await assert.rejects(f.command.home([1],signal()),/already active/);abort.abort(new Error('cancel home'));await failed;release(homingPass());await new Promise<void>(r=>setImmediate(r));assert.equal(f.kin.status.homedAxes,'');assert.equal(f.stops,1);assert.equal(f.command.status.busy,false);
});
test('timeout and missing endstop coverage cannot publish a homed axis',async()=>{
 const timeout=linearHomingFixture({pass:()=>new Promise(()=>{}),timeoutMs:15});await assert.rejects(timeout.command.home([0],signal()),/timed out/);assert.equal(timeout.stops,1);
 const incomplete=linearHomingFixture({pass:async()=>{const p=homingPass();return {...p,stop:{...p.stop,groups:[]}};}});await assert.rejects(incomplete.command.home([0],signal()),/coverage/);assert.equal(incomplete.kin.status.homedAxes,'');assert.equal(incomplete.stops,1);
});
test('retract matches original clamp and retains extra axes, rejecting invisible displacement',()=>{
 assert.deepEqual(homingRetract([300,2,3,4,5],[0,2,3,4,5],5),{retract:[5,2,3,4,5],start:[10,2,3,4,5]});
 assert.deepEqual(homingRetract([-100,2,3,4],[200,2,3,4],1000),{retract:[-100,2,3,4],start:[-400,2,3,4]});
 assert.throws(()=>homingRetract([0,0,0,0],[0,0,0,0],1));assert.throws(()=>homingRetract([1e15,0,0,0],[1e15+1,0,0,0],1e-10),/Unrepresentable/);
});
test('invalid rail ownership or configuration rejects without movement',()=>{
 const f=linearHomingFixture();assert.throws(()=>new LinearHomingCommand(f.kin,f.coordinates,{...f.port},f.rails));assert.throws(()=>new LinearHomingCommand(f.kin,f.coordinates,f.port,f.rails.map(r=>({...r,secondSpeed:0}))));assert.equal(f.events.length,0);
});
test('changing the coordinate transform during a pass revokes authority instead of publishing on another port',async()=>{
 const f=linearHomingFixture({pass:async()=>{f.coordinates.setPort({position:()=>[99,99,99,99],move(){}});return homingPass();}});
 await assert.rejects(f.command.home([0],signal()),/coordinate port changed/);assert.equal(f.kin.status.homedAxes,'');assert.equal(f.stops,1);
});
test('failed motor-off is retained and prevents another homing attempt',async()=>{
 for(const cause of [new Error('safety cleanup failed'),undefined]){
  const f=linearHomingFixture({pass:async()=>homingPass('miss')});f.port.motorOff=async()=>{throw cause;};
  await assert.rejects(f.command.home([0],signal()),AggregateError);assert(f.command.status.cleanupFailed);const before=f.events.length;await assert.rejects(f.command.home([0],signal()),/requires recovery/);assert.equal(f.events.length,before);
 }
});
test('the dispatch queue waits for homing before admitting subsequent movement',async()=>{
 const f=linearHomingFixture({retractDistance:0}),d=new GCodeDispatch({output(){},shutdown:()=>assert.fail()});f.command.register(d);d.register('G1',g=>{assert.equal(f.kin.status.homedAxes,'x');f.coordinates.execute('G1',g.params);});d.setReady(true);
 await d.execute('G28 X\nG1 X10');assert.equal(f.events.at(-1)!.kind,'move');assert.equal(f.coordinates.state.position[0],10);
});
