import test from 'node:test';
import assert from 'node:assert/strict';
import {GCodeMove} from '../src/gcode/move.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {BedMesh} from '../src/motion/bed-mesh.ts';
import {BedMeshMovePort} from '../src/motion/bed-mesh-port.ts';
import {BedMeshProfileBinding} from '../src/motion/bed-mesh-profile-binding.ts';
import {BedMeshProfileStore} from '../src/motion/bed-mesh-profile-store.ts';
import {BedMeshProfiles} from '../src/motion/bed-mesh-profiles.ts';
import {registerBedMeshProfile} from '../src/motion/bed-mesh-profile-command.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {parseKlipperMainText} from '../src/config/klipper-text.ts';
import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
import {motionLimits,type Move} from '../src/motion/lookahead.ts';
const mesh=(z:number)=>new BedMesh({min_x:0,max_x:20,min_y:0,max_y:20,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct',tension:.2},[[z,z],[z,z]]);
const fixture=()=>{const port=new BedMeshMovePort({mesh:mesh(.1),physicalPosition:[0,0,.1,0],limits:motionLimits(300,3000),validate:()=>{}});return {port,gcode:new GCodeMove(port)};};
test('profile command drains old motion then resets coordinate cache before relative movement',async()=>{
 const {port,gcode}=fixture(),trace:Move[][]=[],binding=new BedMeshProfileBinding(port,gcode,{},async moves=>{trace.push(moves);}),store=new BedMeshProfileStore(new BedMeshProfiles(new ConfigurationReader(parseKlipperMainText('','/unused'),null)),new KlipperSaveSession('/unused',''));
 store.save('new',mesh(.3));const d=new GCodeDispatch({output(){},shutdown(){}});d.setReady(true);registerBedMeshProfile(d,store,binding);for(const name of ['G1','G91'])d.register(name,c=>gcode.execute(name,c.params));
 await d.execute('G1 X20\nBED_MESH_PROFILE LOAD=new\nG91\nG1 X-1');assert.equal(trace.length,1);assert.equal(trace[0].at(-1)!.endPos[2],.1);assert.ok(Math.abs(gcode.state.position[2]+.2)<1e-15);assert.ok(Math.abs(port.plannedPosition[2]-.1)<1e-15);assert.equal(port.plannedPosition[0],19);assert.equal(binding.current()!.calcZ(0,0),.3);
});
test('binding refuses an unrelated coordinate port and detects replacement while draining',async()=>{
 const a=fixture(),b=fixture();assert.throws(()=>new BedMeshProfileBinding(a.port,b.gcode,{},async()=>{}),/active coordinate port/);const binding=new BedMeshProfileBinding(a.port,a.gcode,{},async()=>{a.gcode.setPort(b.port);});await assert.rejects(binding.activate(mesh(.2),'new',new AbortController().signal),/changed during drain/);assert.ok(a.port.fault);assert.equal(b.port.fault,undefined);assert.throws(()=>binding.current(),/port changed/);
});
test('cancellation in the gap after port publication but before coordinate refresh stops host admission',async()=>{
 const {port,gcode}=fixture(),c=new AbortController(),cause=new Error('late emergency');const original=port.replaceMesh.bind(port);port.replaceMesh=async(...args)=>{const result=await original(...args);c.abort(cause);return result;};const binding=new BedMeshProfileBinding(port,gcode,{},async()=>{});await assert.rejects(binding.activate(mesh(.2),'new',c.signal),e=>e===cause);assert.equal(port.fault,cause);assert.equal(gcode.state.position[2],0);assert.throws(()=>gcode.execute('G1',{X:1}),e=>e===cause);
});
test('binding owns fade settings and prevents concurrent transitions',async()=>{
 const {port,gcode}=fixture(),fade={end:10};let release!:()=>void;const gate=new Promise<void>(r=>{release=r;}),binding=new BedMeshProfileBinding(port,gcode,fade,async()=>gate);fade.end=.01;const running=binding.activate(mesh(.2),'one',new AbortController().signal);await assert.rejects(binding.activate(mesh(.3),'two',new AbortController().signal),/transition active/);assert.throws(()=>binding.current(),/transition active/);release();await running;assert.equal(port.fault,undefined);assert.equal(binding.current()!.calcZ(0,0),.2);
});
