import test from 'node:test';
import assert from 'node:assert/strict';
import {NativePauseParking,type PauseParkingConfig} from '../src/operations/native-pause-parking.ts';
const config:PauseParkingConfig={parkXY:[5,6],retract:1,lift:2,travelSpeed:30,liftSpeed:5,retractSpeed:10},signal=()=>new AbortController().signal;
function fixture(){const moves:number[][]=[],checks:number[][][]=[],events:string[]=[];const port={pause:async()=>({position:[10,20,30,40],sourceTime:1}),validatePausedPath(legs:readonly {position:readonly number[];speed:number}[]){checks.push(legs.map(l=>[...l.position]));},movePaused:async(p:readonly number[])=>{moves.push([...p]);},resumeStream:async()=>{events.push('resume');},motorOff:async()=>{events.push('stop');}};return {port,moves,checks,events};}
test('configured parking preflights round trip and preserves ordered lift/return/extrusion stages',async()=>{
 const f=fixture(),c=structuredClone(config),parking=new NativePauseParking(f.port,c);c.parkXY=[99,99];const paused=parking.pause(signal());assert.equal(paused,parking.pause(signal()));await paused;
 assert.deepEqual(f.moves,[[10,20,30,39],[10,20,32,39],[5,6,32,39]]);assert.equal(f.checks[0].length,6);assert.equal(parking.status.phase,'parked');await parking.resume(signal());
 assert.deepEqual(f.moves.slice(3),[[10,20,32,39],[10,20,30,39],[10,20,30,40]]);assert.equal(f.checks[1].length,3);assert.deepEqual(f.events,['resume']);assert.equal(parking.status.phase,'idle');
});
test('invalid full path fails before any parking move and stops held motion',async()=>{
 const f=fixture();f.port.validatePausedPath=()=>{throw new Error('park outside limits');};const p=new NativePauseParking(f.port,config);await assert.rejects(p.pause(signal()),/outside limits/);assert.equal(f.moves.length,0);assert.deepEqual(f.events,['stop']);assert.equal(p.status.phase,'failed');
});
test('resume revalidates the full return path before lowering or unretracting',async()=>{
 const f=fixture(),p=new NativePauseParking(f.port,config);await p.pause(signal());f.port.validatePausedPath=()=>{throw new Error('cold extruder');};await assert.rejects(p.resume(signal()),/cold extruder/);assert.equal(f.moves.length,3);assert.deepEqual(f.events,['stop']);
});
test('cancelled intermediate parking leg cannot publish parked or start later legs',async()=>{
 const f=fixture(),abort=new AbortController();f.port.movePaused=async()=>{abort.abort(new Error('cancel park'));abort.signal.throwIfAborted();};const p=new NativePauseParking(f.port,config);await assert.rejects(p.pause(abort.signal),/cancel park/);assert.equal(p.status.phase,'failed');assert.deepEqual(f.events,['stop']);
});
test('accounting resumes after parking return and before a held command can continue',async()=>{
 const {ExtrusionAccounting}=await import('../src/gcode/extrusion-accounting.ts'),meter=new ExtrusionAccounting(),f=fixture();meter.begin();meter.accepted(0,.4,1);meter.setActive(false);
 f.port.movePaused=async()=>{assert.equal(meter.filamentUsed,.4);meter.accepted(0,1,1);};
 f.port.resumeStream=async()=>{meter.accepted(.4,.401,1);};
 const parking=new NativePauseParking(f.port,config,()=>meter.setActive(true));await parking.pause(signal());await parking.resume(signal());meter.accepted(.401,1,1);assert.equal(meter.filamentUsed,1);
});
