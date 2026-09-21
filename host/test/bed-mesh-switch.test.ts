import test from 'node:test';
import assert from 'node:assert/strict';
import {BedMesh} from '../src/motion/bed-mesh.ts';
import {BedMeshMovePort} from '../src/motion/bed-mesh-port.ts';
import {motionLimits} from '../src/motion/lookahead.ts';
import {GCodeMove} from '../src/gcode/move.ts';
const mesh=(z:number)=>new BedMesh({min_x:0,max_x:20,min_y:0,max_y:20,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct',tension:.2},[[z,z],[z,z]]);
const port=()=>new BedMeshMovePort({mesh:mesh(.1),physicalPosition:[0,0,.1,0],limits:motionLimits(300,3000),validate:()=>{}});
test('switch drains old compensated trajectories before publishing new logical origin',async()=>{
 const p=port(),g=new GCodeMove(p);g.execute('G1',{X:20});const physical=p.plannedPosition;let release!:()=>void;const barrier=new Promise<void>(r=>{release=r;});let drained=0;
 const changing=p.replaceMesh(mesh(.3),{},async moves=>{drained=moves.length;assert.equal(moves.at(-1)!.endPos[2],.1);assert.ok(moves.every(m=>m.profile));await barrier;});assert.ok(drained>0);assert.throws(()=>p.move([0,0,0,0],10),/admission active/);assert.throws(()=>p.position(),/admission active/);release();const logical=await changing;assert.deepEqual(p.plannedPosition,physical);assert.ok(Math.abs(logical[2]+.2)<1e-15);g.resetPosition();g.execute('G91');g.execute('G1',{X:-1});assert.ok(Math.abs(p.plannedPosition[2]-.1)<1e-15);
 await p.replaceMesh(null,{},async()=>{});g.resetPosition();assert.deepEqual(g.state.position,p.plannedPosition);
});
test('invalid replacement and pre-cancellation leave queued motion and old mesh usable',async()=>{
 const p=port();p.move([10,0,0,0],10);const count=p.pending;await assert.rejects(p.replaceMesh(mesh(20),{end:10},async()=>{throw new Error('must not drain');}),/fade/);await assert.rejects(p.replaceMesh(null,{},async()=>{},AbortSignal.abort(new Error('cancel'))),/cancel/);assert.equal(p.pending,count);assert.equal(p.fault,undefined);assert.equal(p.currentMesh()!.calcZ(0,0),.1);
});
test('drain failure latches the original fault and prevents all further admission',async()=>{
 const p=port(),cause=new Error('downstream failed');p.move([10,0,0,0],10);await assert.rejects(p.replaceMesh(mesh(.2),{},async()=>{throw cause;}),e=>e===cause);assert.equal(p.fault,cause);assert.equal(p.pending,0);assert.throws(()=>p.move([1,0,0,0],10),e=>e===cause);
});
test('cancellation during drain prevents publication and retains the first shutdown cause',async()=>{
 const p=port(),c=new AbortController(),cause=new Error('emergency');let release!:()=>void;const barrier=new Promise<void>(r=>{release=r;});const changing=p.replaceMesh(mesh(.2),{},async()=>barrier,c.signal);c.abort(cause);p.shutdown(new Error('later'));release();await assert.rejects(changing,e=>e===cause);assert.equal(p.fault,cause);assert.deepEqual(p.plannedPosition,[0,0,.1,0]);assert.throws(()=>p.position(),e=>e===cause);
});
