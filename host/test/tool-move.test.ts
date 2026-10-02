import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolMovePort} from '../src/gcode/tool-move.ts';
import {GCodeMove} from '../src/gcode/move.ts';
function fixture(drain=async(_s:AbortSignal)=>{}){let physical=[0,0,0,10,20];const moves:number[][]=[];const port=new ToolMovePort({position:()=>physical,move:p=>{physical=[...p];moves.push([...p]);}},2,drain),coordinates=new GCodeMove(port);return {port,coordinates,moves,get physical(){return physical;}};}
const signal=()=>new AbortController().signal;
test('tool selection projects only active E and resets origin and flow without moving inactive motors',async()=>{
 const f=fixture(),c=f.coordinates;c.execute('M83');c.execute('M221',{S:200});c.execute('G1',{E:1});assert.deepEqual(f.physical,[0,0,0,12,20]);
 c.execute('SAVE_GCODE_STATE',{NAME:'before'});await f.port.select(1,c,signal());assert.equal(f.moves.length,1);assert.equal(c.state.extrudeFactor,1);assert.equal(c.gcodePosition[3],0);
 assert.throws(()=>c.execute('RESTORE_GCODE_STATE',{NAME:'before'}),/state/i);
 c.execute('M82');c.execute('G1',{E:2});assert.deepEqual(f.physical,[0,0,0,12,22]);await f.port.select(0,c,signal());c.execute('G1',{E:3});assert.deepEqual(f.physical,[0,0,0,15,22]);
 const before=c.state;await f.port.select(0,c,signal());assert.deepEqual(c.state,before);
});
test('cancelled drain retains tool and coordinate state and rejects simultaneous movement',async()=>{
 const barrier=Promise.withResolvers<void>(),f=fixture(async()=>barrier.promise),controller=new AbortController(),before=f.coordinates.state;
 const pending=f.port.select(1,f.coordinates,controller.signal);assert.throws(()=>f.port.move([0,0,0,2],5),/selection/);
 await assert.rejects(f.port.select(0,f.coordinates,signal()),/exclusive/);controller.abort(Error('cancel switch'));barrier.resolve();await assert.rejects(pending,/cancel/);
 assert.equal(f.port.active,0);assert.deepEqual(f.coordinates.state,before);assert.equal(f.moves.length,0);
});
test('drain failure, unknown tools and replaced coordinate owner cannot publish a selection',async()=>{
 const f=fixture(async()=>{throw Error('stop');});await assert.rejects(f.port.select(1,f.coordinates,signal()),/stop/);assert.equal(f.port.active,0);
 await assert.rejects(f.port.select(2,f.coordinates,signal()),/Unknown/);f.coordinates.setPort({position:()=>[0,0,0,0],move(){}});await assert.rejects(f.port.select(1,f.coordinates,signal()),/ownership/);
});
