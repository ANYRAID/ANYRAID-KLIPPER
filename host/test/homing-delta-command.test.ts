import test from 'node:test';
import assert from 'node:assert/strict';
import {DeltaHomingCommand,type DeltaHomingPort} from '../src/homing/delta-command.ts';
import {DeltaKinematics} from '../src/kinematics/delta.ts';
import {GCodeMove} from '../src/gcode/move.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {homingPass} from './helpers/linear-homing.ts';
import type {HomingPass} from '../src/homing/linear-command.ts';
function pass(kind:'hit'|'miss'|'stuck'='hit'):HomingPass{
 const parts=[homingPass(),homingPass(kind),homingPass()];
 return {movingSteppers:parts.map((_,member)=>({member,oid:1})),stop:{hitClock:null,groups:parts.map(p=>p.stop.groups[0]),memberOffsets:[0,1,2],reasons:parts.flatMap(p=>p.stop.reasons),positions:parts.flatMap((p,member)=>p.stop.positions.map(row=>({...row,member})))},histories:parts.flatMap((p,member)=>p.histories.map(h=>({...h,member}))),triggerClocks:parts.map(p=>p.triggerClocks[0])};
}
function fixture(run:(attempt:number)=>Promise<HomingPass>=async()=>pass(),timeout=1000,retractDistance=5){
 const kin=new DeltaKinematics({radius:100,printRadius:100,arms:[250,251,250],angles:[210,331,90],endstops:[300,301,300],stepDistances:[.0125,.0125,.0125],minimumZ:0,maxVelocity:300,maxAccel:3000,maxZVelocity:100,maxZAccel:1000});
 let position=[0,0,0,7],attempt=0,stops=0;const events:{kind:string;position:number[];speed?:number}[]=[];
 const port:DeltaHomingPort={position:()=>position,move(p){position=[...p];},assertActive(){},async drain(s){s.throwIfAborted();},async forcePosition(p,s){s.throwIfAborted();position=[...p];events.push({kind:'force',position});},async home(p,speed,axis,s){assert.equal(axis,2);assert.equal(kin.status.homedAxes,'');events.push({kind:'home',position:[...p],speed});const result=await run(++attempt);s.throwIfAborted();position=[...p];position[2]+=.02;return result;},async retract(p,speed,axis,s){s.throwIfAborted();assert.equal(axis,2);position=[...p];events.push({kind:'retract',position,speed});},async motorOff(){stops++;}};
 const coordinates=new GCodeMove(port),settings={speed:40,secondSpeed:10,retractSpeed:20,retractDistance,endstops:['stepper_a','stepper_b','stepper_c']},command=new DeltaHomingCommand(kin,coordinates,port,settings,timeout);
 return {kin,port,coordinates,settings,command,events,get stops(){return stops;}};
}
const signal=()=>new AbortController().signal;
test('Delta G28 X performs both all-tower passes and atomically grants XYZ after final correction',async()=>{
 const f=fixture(),dispatch=new GCodeDispatch({output(){},shutdown(){assert.fail();}});f.command.register(dispatch);dispatch.setReady(true);
 f.coordinates.execute('SET_GCODE_OFFSET',{X:.5});f.coordinates.execute('G92',{Y:5});let finish=0;
 f.port.finishDeltaHoming=async(_pass,s)=>{s.throwIfAborted();assert.equal(f.kin.status.homedAxes,'');finish++;};
 await dispatch.execute('G28 X');assert.equal(f.kin.status.homedAxes,'xyz');assert.equal(finish,1);assert.equal(f.stops,0);
 assert.deepEqual(f.events.filter(e=>e.kind==='home').map(e=>e.speed),[40,10]);
 const home=f.kin.homePosition,forces=f.events.filter(e=>e.kind==='force');assert.deepEqual(forces[0].position,[...f.kin.homingMove().force,7]);assert.equal(forces[1].position[2],home[2]-10);
 assert.equal(f.events.find(e=>e.kind==='retract')!.position[2],home[2]-5);assert.equal(f.coordinates.state.position[3],7);assert.equal(f.coordinates.state.base[0],.5);assert.equal(f.coordinates.state.base[1],0);
});
test('Delta missing or stuck B endstop revokes all axes and reports the correct switch',async()=>{
 for(const kind of ['miss','stuck'] as const){const f=fixture(async n=>pass(kind==='miss'||n===2?kind:'hit'));f.kin.resetPosition('xyz');await assert.rejects(f.command.home(signal()),e=>e instanceof Error&&e.message.includes('stepper_b'));assert.equal(f.kin.status.homedAxes,'');assert.equal(f.stops,1);assert.equal(f.events.filter(e=>e.kind==='home').length,kind==='miss'?1:2);}
});
test('Delta cancellation fences late completion, concurrency and timeout',async()=>{
 let release!:(p:HomingPass)=>void,enter!:()=>void;const entered=new Promise<void>(r=>enter=r),held=new Promise<HomingPass>(r=>release=r),f=fixture(async()=>{enter();return held;}),abort=new AbortController();
 const running=f.command.home(abort.signal),rejected=assert.rejects(running,/cancel Delta/);await entered;await assert.rejects(f.command.home(signal()),/already active/);abort.abort(new Error('cancel Delta'));await rejected;release(pass());await new Promise<void>(r=>setImmediate(r));assert.equal(f.stops,1);assert.equal(f.kin.status.homedAxes,'');
 const timed=fixture(()=>new Promise(()=>{}),10);await assert.rejects(timed.command.home(signal()),/timed out/);assert.equal(timed.stops,1);
});
test('Delta final correction failure and cleanup failure prevent authority and retry',async()=>{
 const f=fixture();f.port.finishDeltaHoming=async()=>{throw new Error('phase failed');};f.port.motorOff=async()=>{throw new Error('stop failed');};
 await assert.rejects(f.command.home(signal()),AggregateError);assert.equal(f.kin.status.homedAxes,'');assert.equal(f.command.status.cleanupFailed,true);await assert.rejects(f.command.home(signal()),/requires recovery/);
});
test('Delta zero retract skips second pass, while changed coordinate owner or missing coverage fails',async()=>{
 const once=fixture(undefined,1000,0);await once.command.home(signal());assert.equal(once.events.filter(e=>e.kind==='home').length,1);assert.equal(once.kin.status.homedAxes,'xyz');
 const missing=fixture(async()=>homingPass());await assert.rejects(missing.command.home(signal()),/coverage/);assert.equal(missing.stops,1);
 const changed=fixture(async()=>{changed.coordinates.setPort({position:()=>[0,0,0,0],move(){}});return pass();});await assert.rejects(changed.command.home(signal()),/coordinate port changed/);assert.equal(changed.kin.status.homedAxes,'');assert.equal(changed.stops,1);
});
test('Delta shared startup signature validates axis requests before any motion',async()=>{
 const f=fixture();for(const axes of [[],[0,0],[3]])await assert.rejects(f.command.home(axes as (0|1|2)[],signal()),/Invalid homing axes/);assert.equal(f.events.length,0);assert.equal(f.stops,0);
 await f.command.home([1],signal());assert.equal(f.kin.status.homedAxes,'xyz');
});
